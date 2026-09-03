import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { FileEntry, type FileEntryType } from '../entities/file-entry.entity';
import { FileEntryStore } from './file-entry-store';

/** One unit the user trashed (its descendants are hidden behind it). */
export interface TrashListing {
  entryId: string;
  originalPath: string;
  name: string;
  type: FileEntryType;
  size: number;
  lastModified: number;
}

/**
 * The trash: rows whose path is cleared (so their name frees up) but whose
 * bytes are kept until the user restores or deletes them, or the retention
 * window expires. Shares FileEntryStore's row/path plumbing with the live index.
 */
@Injectable()
export class TrashService extends FileEntryStore {
  constructor(
    @InjectRepository(FileEntry)
    entries: Repository<FileEntry>,
    storage: StorageService,
  ) {
    super(entries, storage);
  }

  /**
   * Trashes items by clearing their path — which frees the name for reuse —
   * and remembering where to put them back. Descendants are tagged with the
   * same root so the trash lists one entry per thing the user deleted.
   */
  async moveToTrash(userId: string, paths: string[]): Promise<void> {
    const now = new Date();
    for (const rawPath of paths) {
      const path = this.normalizePath(rawPath);
      if (!path) continue;
      const entry = await this.liveEntry(userId, path);
      if (!entry) continue;
      const group = [entry, ...(await this.descendantsOf(userId, path))];
      for (const row of group) {
        row.trashedAt = now;
        row.trashedFromPath = row.path;
        row.trashRootId = entry.id;
        this.clearPath(row);
      }
      await this.entries.manager.transaction((manager) => manager.save(group));
    }
  }

  async listTrash(userId: string): Promise<TrashListing[]> {
    const trashed = await this.entries.find({
      where: { userId, trashedAt: Not(IsNull()) },
      order: { trashedAt: 'DESC' },
    });
    return trashed
      .filter((row) => row.trashRootId === row.id)
      .map((root) => ({
        entryId: root.id,
        originalPath: root.trashedFromPath ?? root.name,
        name: root.name,
        type: root.type,
        size: trashed
          .filter((row) => row.trashRootId === root.id)
          .reduce((sum, row) => sum + row.size, 0),
        // When it was trashed is what the trash view sorts and expires on.
        lastModified: (root.trashedAt ?? root.modifiedAt).getTime(),
      }));
  }

  /** Puts trashed groups back, renaming if the old name is taken again. */
  async restore(userId: string, entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      const group = await this.trashGroup(userId, entryId);
      const root = group.find((row) => row.id === entryId);
      if (!root) continue;

      const oldPath = root.trashedFromPath ?? root.name;
      const oldParent = this.parentOf(oldPath);
      // The folder it came from may itself be gone by now; fall back to root.
      const parent = (await this.folderExists(userId, oldParent))
        ? oldParent
        : '';
      const name = await this.freeName(userId, parent, root.name);
      const rootPath = this.joinPath(parent, name);
      this.assertPathLength(rootPath);

      for (const row of group) {
        const from = row.trashedFromPath ?? row.name;
        const path =
          row.id === root.id
            ? rootPath
            : `${rootPath}${from.slice(oldPath.length)}`;
        this.assertPathLength(path);
        this.setPath(row, this.parentOf(path), this.nameOf(path));
        row.trashedAt = null;
        row.trashedFromPath = null;
        row.trashRootId = null;
      }
      await this.entries.manager.transaction((manager) => manager.save(group));
    }
  }

  /** Deletes trashed groups for good, blobs included. */
  async deleteTrashEntries(userId: string, entryIds: string[]): Promise<void> {
    for (const entryId of entryIds) {
      await this.destroy(userId, await this.trashGroup(userId, entryId));
    }
  }

  async emptyTrash(userId: string): Promise<void> {
    await this.destroy(
      userId,
      await this.entries.find({
        where: { userId, trashedAt: Not(IsNull()) },
      }),
    );
  }

  /** Deletes trash older than the retention window. Returns entries removed. */
  async purgeExpiredTrash(
    userId: string,
    olderThanMs: number,
  ): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    const expired = (await this.listTrash(userId)).filter(
      (entry) => entry.lastModified < cutoff,
    );
    if (expired.length === 0) return 0;
    await this.deleteTrashEntries(
      userId,
      expired.map((entry) => entry.entryId),
    );
    return expired.length;
  }

  private trashGroup(userId: string, entryId: string): Promise<FileEntry[]> {
    return this.entries.find({ where: { userId, trashRootId: entryId } });
  }
}
