import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { FileEntry, type FileEntryType } from '../entities/file-entry.entity';
import { FileEntryStore } from './file-entry-store';

/** One row of the drive listing, in the shape the frontend already consumes. */
export interface DriveListing {
  /** Relative path; folders end with "/" so the client can tell them apart. */
  key: string;
  size: number;
  lastModified: number;
}

/** Blobs live under this prefix; nothing about a blob key is user-visible. */
const BLOB_PREFIX = 'blobs/';

/**
 * Owns the drive's structure: what exists, what it's called and where it sits.
 *
 * S3 keeps only bytes, under keys nothing ever renames. Everything the user
 * experiences as file management — listing, foldering, moving, renaming —
 * happens here as row updates, which is what makes those operations instant
 * regardless of file size. (S3 can't rename at all: it copies, and it refuses
 * to copy anything over 5GB in one request.) Trashing lives in TrashService,
 * which shares this service's row/path plumbing through FileEntryStore.
 */
@Injectable()
export class FileIndexService extends FileEntryStore {
  private readonly logger = new Logger(FileIndexService.name);

  constructor(
    @InjectRepository(FileEntry)
    entries: Repository<FileEntry>,
    storage: StorageService,
  ) {
    super(entries, storage);
  }

  // --- Listing --------------------------------------------------------------

  /**
   * Everything live in the user's drive. Imports from S3 on first use so a
   * drive that predates this index doesn't come up empty.
   */
  async listDrive(userId: string): Promise<DriveListing[]> {
    await this.importIfEmpty(userId);
    const rows = await this.entries.find({
      where: { userId, trashedAt: IsNull(), status: 'ready' },
      order: { path: 'ASC' },
    });
    return rows.map((row) => ({
      key: row.type === 'folder' ? `${row.path ?? ''}/` : (row.path ?? ''),
      size: row.size,
      lastModified: row.modifiedAt.getTime(),
    }));
  }

  // --- Folders --------------------------------------------------------------

  /** Creates a folder, renaming it if that name is taken. Returns its path. */
  async createFolder(
    userId: string,
    parentPath: string,
    name: string,
  ): Promise<string> {
    const parent = this.normalizePath(parentPath);
    await this.assertFolderExists(userId, parent);
    const entry = await this.insertUnderFreeName(
      userId,
      parent,
      this.safeName(name),
      'folder',
    );
    return entry.path ?? '';
  }

  // --- Uploads --------------------------------------------------------------

  /**
   * Reserves a row for an upload and returns the blob key its bytes go to.
   *
   * The row is created before the transfer starts (as `pending`) so the name is
   * settled once, up front, and so an upload that never finishes still leaves a
   * record pointing at the blob that needs cleaning up.
   */
  async beginUpload(
    userId: string,
    parentPath: string,
    name: string,
    contentType?: string,
  ): Promise<{ entryId: string; blobKey: string; name: string; path: string }> {
    const parent = this.normalizePath(parentPath);
    // Dropping a folder uploads its files with their subfolders in the path, and
    // those folders don't exist yet — the old key-prefix layout created them
    // implicitly. So an upload creates the folders it needs, like `mkdir -p`.
    await this.ensureFolderPath(userId, parent);
    const blobKey = `${BLOB_PREFIX}${randomUUID()}`;
    const entry = await this.insertUnderFreeName(
      userId,
      parent,
      this.safeName(name),
      'file',
      { blobKey, contentType: contentType ?? null, status: 'pending' },
    );
    return {
      entryId: entry.id,
      blobKey,
      name: entry.name,
      path: entry.path ?? entry.name,
    };
  }

  /**
   * Confirms an upload landed, recording what S3 actually stored. Reads size,
   * type and ETag back from S3 rather than trusting the client, so the index
   * can't drift from the bytes.
   */
  async completeUpload(userId: string, blobKey: string): Promise<void> {
    const entry = await this.entries.findOne({ where: { userId, blobKey } });
    if (!entry) throw new BadRequestException('Unknown upload');
    const head = await this.storage.headBlob(userId, blobKey);
    entry.size = head.size;
    entry.contentType = head.contentType ?? entry.contentType;
    entry.modifiedAt = head.lastModified;
    entry.status = 'ready';
    await this.entries.save(entry);
  }

  /** Drops a reserved row and its blob after a failed or aborted upload. */
  async cancelUpload(userId: string, blobKey: string): Promise<void> {
    const entry = await this.entries.findOne({ where: { userId, blobKey } });
    if (!entry) return;
    await this.storage.deleteBlobs(userId, [blobKey]).catch(() => undefined);
    await this.entries.remove(entry);
  }

  // --- Reading --------------------------------------------------------------

  /** Resolves a visible path to the blob and name a download URL needs. */
  async resolveFile(
    userId: string,
    path: string,
  ): Promise<{ blobKey: string; name: string }> {
    const entry = await this.liveEntry(userId, this.normalizePath(path));
    // `ready` matters: a reserved row's bytes may not exist yet, and signing a
    // URL for them would hand the browser a 404 instead of a clear error.
    if (
      !entry ||
      entry.type !== 'file' ||
      !entry.blobKey ||
      entry.status !== 'ready'
    ) {
      throw new BadRequestException('No such file');
    }
    return { blobKey: entry.blobKey, name: entry.name };
  }

  /**
   * Resolves a folder to every ready file inside it, with paths relative to
   * the folder itself (what a zip of that folder should contain).
   */
  async resolveFolderFiles(
    userId: string,
    path: string,
  ): Promise<{
    name: string;
    files: { relativePath: string; blobKey: string }[];
  }> {
    const folderPath = this.normalizePath(path);
    const folder = await this.liveEntry(userId, folderPath);
    if (!folder || folder.type !== 'folder') {
      throw new BadRequestException('No such folder');
    }
    const files = (await this.descendantsOf(userId, folderPath))
      .filter(
        (entry): entry is FileEntry & { blobKey: string } =>
          entry.type === 'file' && !!entry.blobKey && entry.status === 'ready',
      )
      .map((entry) => ({
        relativePath: (entry.path ?? '').slice(folderPath.length + 1),
        blobKey: entry.blobKey,
      }));
    return { name: folder.name, files };
  }

  // --- Moving and renaming --------------------------------------------------

  /**
   * Moves items into `destination`. A folder takes its whole subtree along,
   * which is a path rewrite here — no bytes are copied and size is irrelevant.
   *
   * The whole batch is checked before anything moves, so a rejected item (say,
   * a folder being moved inside itself) doesn't leave the earlier items of the
   * same request already relocated.
   */
  async move(
    userId: string,
    paths: string[],
    destination: string,
  ): Promise<void> {
    const dest = this.normalizePath(destination);
    await this.assertFolderExists(userId, dest);

    const movable: FileEntry[] = [];
    for (const rawPath of paths) {
      const path = this.normalizePath(rawPath);
      if (!path) continue;
      const entry = await this.liveEntry(userId, path);
      if (!entry || entry.parentPath === dest) continue;
      // Moving a folder inside itself would detach the subtree from the tree.
      if (
        entry.type === 'folder' &&
        (dest === path || dest.startsWith(`${path}/`))
      ) {
        throw new BadRequestException('Cannot move a folder into itself');
      }
      movable.push(entry);
    }

    for (const entry of movable) {
      await this.relocate(userId, entry, dest, entry.name);
    }
  }

  /** Renames one item in place, keeping its subtree attached. */
  async rename(userId: string, path: string, name: string): Promise<string> {
    const entry = await this.liveEntry(userId, this.normalizePath(path));
    if (!entry) throw new BadRequestException('No such item');
    const safe = this.safeName(name);
    if (safe === entry.name) return entry.path ?? '';
    return this.relocate(userId, entry, entry.parentPath ?? '', safe);
  }

  /**
   * Rewrites an entry's parent and/or name, carrying its descendants with it.
   * Every new path is computed and validated before anything is written, and
   * the writes share a transaction, so a failure can't leave half a subtree
   * pointing at the old location.
   */
  private async relocate(
    userId: string,
    entry: FileEntry,
    newParent: string,
    desiredName: string,
  ): Promise<string> {
    const oldPath = entry.path ?? '';
    const descendants =
      entry.type === 'folder' ? await this.descendantsOf(userId, oldPath) : [];
    // Captured before the first attempt: a retry has to rebuild paths from the
    // original suffixes, not from rows a previous attempt already rewrote.
    const suffixes = descendants.map((child) =>
      (child.path ?? '').slice(oldPath.length),
    );

    for (let attempt = 1; ; attempt += 1) {
      const name = await this.freeName(userId, newParent, desiredName);
      const newPath = this.joinPath(newParent, name);
      this.assertPathLength(newPath);
      const rewrites = descendants.map((child, index) => ({
        child,
        path: `${newPath}${suffixes[index]}`,
      }));
      for (const rewrite of rewrites) this.assertPathLength(rewrite.path);

      this.setPath(entry, newParent, name);
      for (const { child, path } of rewrites) {
        this.setPath(child, this.parentOf(path), this.nameOf(path));
      }

      try {
        await this.entries.manager.transaction(async (manager) => {
          await manager.save(entry);
          if (descendants.length > 0) await manager.save(descendants);
        });
        return newPath;
      } catch (error) {
        // Someone took the name between the check and the write.
        if (!this.isDuplicateKey(error) || attempt >= 5) throw error;
      }
    }
  }

  // --- Maintenance ----------------------------------------------------------

  /**
   * Cleans up uploads that were reserved but never confirmed — a tab closed
   * mid-transfer can't send the completion call, and the bytes it did manage to
   * write would otherwise sit in S3 billing with nothing pointing at them.
   *
   * The window has to be generous: a large upload on a slow connection can run
   * for hours, and cancelling a live one would fail it at the last step.
   */
  async purgeStaleUploads(
    userId: string,
    olderThanMs: number,
  ): Promise<number> {
    const stale = await this.entries.find({
      where: {
        userId,
        status: 'pending',
        createdAt: LessThan(new Date(Date.now() - olderThanMs)),
      },
    });
    if (stale.length === 0) return 0;
    await this.destroy(userId, stale);
    return stale.length;
  }

  // --- Import from S3 -------------------------------------------------------

  /**
   * Builds index rows from whatever is already in the bucket, so a drive
   * created before this index existed keeps working without moving a byte:
   * each object's existing key simply becomes that row's (opaque) blob key.
   *
   * Runs when a user has no rows at all. An empty drive costs one LIST per
   * refresh until something is uploaded, which is a single cheap request.
   */
  private async importIfEmpty(userId: string): Promise<void> {
    if ((await this.entries.count({ where: { userId } })) > 0) return;
    const imported = await this.indexObjects(
      userId,
      await this.storage.listAllUserKeys(userId),
    );
    if (imported > 0) {
      this.logger.log(`Indexed ${imported} pre-existing objects for ${userId}`);
    }
  }

  /**
   * Adopts objects that exist in S3 but have no row — a file uploaded straight
   * through the AWS console, say. Without this they would be invisible in the
   * app forever, since the index (not the bucket) is what listings read.
   *
   * Blobs are the one thing it won't adopt: their keys carry no path, so a blob
   * with no row can't be placed anywhere. Those are reported instead, because
   * they are bytes nobody is paying attention to but everybody is paying for.
   */
  async reconcile(
    userId: string,
  ): Promise<{ adopted: number; orphanBlobs: number }> {
    const objects = await this.storage.listAllUserKeys(userId);
    const rows = await this.entries.find({
      where: { userId },
      select: { blobKey: true },
    });
    const indexed = new Set(
      rows.map((row) => row.blobKey).filter((key): key is string => !!key),
    );
    const unindexed = objects.filter((object) => !indexed.has(object.key));
    return {
      adopted: await this.indexObjects(
        userId,
        unindexed.filter((object) => !object.key.startsWith(BLOB_PREFIX)),
      ),
      orphanBlobs: unindexed.filter((object) =>
        object.key.startsWith(BLOB_PREFIX),
      ).length,
    };
  }

  /**
   * Turns S3 objects into rows, inventing the folder rows their keys imply.
   * Paths already in use are left alone (folders) or given a free name (files),
   * so this is safe to run against a drive that is already partly indexed.
   */
  private async indexObjects(
    userId: string,
    objects: { key: string; size: number; lastModified: Date }[],
  ): Promise<number> {
    if (objects.length === 0) return 0;
    const existing = await this.entries.find({
      where: { userId },
      select: { path: true },
    });
    const taken = new Set(
      existing.map((row) => row.path).filter((path): path is string => !!path),
    );
    const rows: FileEntry[] = [];

    const addFolders = (path: string, at: Date) => {
      for (const ancestor of this.ancestorsOf(path)) {
        if (taken.has(ancestor)) continue;
        taken.add(ancestor);
        rows.push(this.buildRow(userId, ancestor, 'folder', 0, at, null));
      }
    };

    for (const object of objects) {
      // Blobs are only reachable through a row, so one without a row has no
      // path to be placed at; `reconcile` reports them instead.
      if (object.key.startsWith(BLOB_PREFIX)) continue;

      const path = this.normalizePath(object.key);
      if (!path) continue;

      // A key ending in "/" is an explicit (empty) folder marker.
      if (object.key.endsWith('/')) {
        if (taken.has(path)) continue;
        addFolders(path, object.lastModified);
        taken.add(path);
        rows.push(
          this.buildRow(userId, path, 'folder', 0, object.lastModified, null),
        );
        continue;
      }

      const finalPath = this.freePathIn(taken, path);
      addFolders(finalPath, object.lastModified);
      taken.add(finalPath);
      rows.push(
        this.buildRow(
          userId,
          finalPath,
          'file',
          object.size,
          object.lastModified,
          object.key,
        ),
      );
    }

    if (rows.length === 0) return 0;
    return (await this.entries.save(rows)).length;
  }

  private buildRow(
    userId: string,
    path: string,
    type: FileEntryType,
    size: number,
    modifiedAt: Date,
    blobKey: string | null,
  ): FileEntry {
    const row = this.entries.create({
      userId,
      type,
      blobKey,
      size: type === 'file' ? size : 0,
      modifiedAt,
      status: 'ready',
    });
    this.setPath(row, this.parentOf(path), this.nameOf(path));
    return row;
  }

  /** `path` if free in `taken`, else "name (1)", "name (2)", … (same rule as uploads). */
  private freePathIn(taken: Set<string>, path: string): string {
    const parent = this.parentOf(path);
    const name = this.nextFreeName(
      { has: (candidate) => taken.has(this.joinPath(parent, candidate)) },
      this.nameOf(path),
    );
    return this.joinPath(parent, name);
  }

  // --- Row helpers ----------------------------------------------------------

  /**
   * Inserts a row under the first free name. Retries on a duplicate key
   * because two uploads can pick the same free name concurrently — the unique
   * index is what actually decides, and one of them has to pick again.
   */
  private async insertUnderFreeName(
    userId: string,
    parentPath: string,
    desiredName: string,
    type: FileEntryType,
    extra: Partial<FileEntry> = {},
  ): Promise<FileEntry> {
    for (let attempt = 1; ; attempt += 1) {
      const name = await this.freeName(userId, parentPath, desiredName);
      const path = this.joinPath(parentPath, name);
      this.assertPathLength(path);
      const row = this.entries.create({
        userId,
        type,
        size: 0,
        modifiedAt: new Date(),
        status: 'ready',
        ...extra,
      });
      this.setPath(row, parentPath, name);
      try {
        return await this.entries.save(row);
      } catch (error) {
        if (!this.isDuplicateKey(error) || attempt >= 5) throw error;
      }
    }
  }

  private async assertFolderExists(
    userId: string,
    path: string,
  ): Promise<void> {
    if (!(await this.folderExists(userId, path))) {
      throw new BadRequestException(`No such folder: ${path}`);
    }
  }

  /**
   * Creates every folder in `path` that doesn't exist yet. Names are used
   * exactly as given — the whole point is to land at this path, so a taken name
   * is either the folder we wanted or an error, never a renamed sibling.
   */
  private async ensureFolderPath(userId: string, path: string): Promise<void> {
    let current = '';
    for (const segment of path.split('/').filter(Boolean)) {
      current = this.joinPath(current, segment);
      const existing = await this.liveEntry(userId, current);
      if (existing) {
        if (existing.type !== 'folder') {
          throw new BadRequestException(`Not a folder: ${current}`);
        }
        continue;
      }
      const row = this.entries.create({
        userId,
        type: 'folder',
        size: 0,
        modifiedAt: new Date(),
        status: 'ready',
      });
      this.setPath(row, this.parentOf(current), segment);
      try {
        await this.entries.save(row);
      } catch (error) {
        // Parallel uploads into the same new folder race to create it; whoever
        // lost the race just carries on with the folder that now exists.
        if (!this.isDuplicateKey(error)) throw error;
      }
    }
  }

  private safeName(name: string): string {
    const trimmed = name.trim();
    if (!trimmed || trimmed.includes('/')) {
      throw new BadRequestException(`Invalid name: ${name}`);
    }
    return trimmed;
  }

  /** Every folder path leading to `path`, outermost first. */
  private ancestorsOf(path: string): string[] {
    const parts = this.parentOf(path).split('/').filter(Boolean);
    return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  }
}
