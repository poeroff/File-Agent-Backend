import { BadRequestException } from '@nestjs/common';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import {
  FileEntry,
  MAX_PATH_LENGTH,
  hashPath,
} from '../entities/file-entry.entity';

/**
 * The row + path plumbing shared by the live index (FileIndexService) and the
 * trash (TrashService). Both operate on the same FileEntry table, so the helpers
 * that read, rename, detach and delete rows — and that normalise paths — live
 * here once and are inherited by both, rather than being duplicated or reached
 * into across services.
 */
export abstract class FileEntryStore {
  constructor(
    protected readonly entries: Repository<FileEntry>,
    protected readonly storage: StorageService,
  ) {}

  /**
   * Blobs go first: deleting an object that is already gone is a no-op, so if
   * the row deletion fails the user can simply delete again. The other order
   * would leave paid-for bytes with nothing pointing at them.
   */
  protected async destroy(userId: string, rows: FileEntry[]): Promise<void> {
    if (rows.length === 0) return;
    const blobKeys = rows
      .filter((row): row is FileEntry & { blobKey: string } =>
        Boolean(row.type === 'file' && row.blobKey),
      )
      .map((row) => row.blobKey);
    await this.storage.deleteBlobs(userId, blobKeys);
    await this.entries.remove(rows);
  }

  protected setPath(row: FileEntry, parentPath: string, name: string): void {
    const path = this.joinPath(parentPath, name);
    row.name = name;
    row.path = path;
    row.pathHash = hashPath(path);
    row.parentPath = parentPath;
    row.parentPathHash = hashPath(parentPath);
  }

  /** Detaches a row from the tree (what being in the trash means). */
  protected clearPath(row: FileEntry): void {
    row.path = null;
    row.pathHash = null;
    row.parentPath = null;
    row.parentPathHash = null;
  }

  protected liveEntry(userId: string, path: string): Promise<FileEntry | null> {
    return this.entries.findOne({
      where: { userId, pathHash: hashPath(path), trashedAt: IsNull() },
    });
  }

  /** Everything under `path`, excluding `path` itself. */
  protected descendantsOf(userId: string, path: string): Promise<FileEntry[]> {
    return this.entries
      .createQueryBuilder('entry')
      .where('entry.userId = :userId', { userId })
      .andWhere('entry.trashedAt IS NULL')
      .andWhere('entry.path LIKE :prefix', {
        prefix: `${this.escapeLike(path)}/%`,
      })
      .getMany();
  }

  protected async folderExists(userId: string, path: string): Promise<boolean> {
    if (path === '') return true; // the drive root always exists
    return (await this.liveEntry(userId, path))?.type === 'folder';
  }

  /**
   * `name` if free in `parentPath`, otherwise "name (1)", "name (2)", … so an
   * upload never silently replaces a different file that happens to share a
   * name. Files keep their extension: "report (1).pdf".
   */
  protected async freeName(
    userId: string,
    parentPath: string,
    name: string,
  ): Promise<string> {
    const siblings = await this.entries.find({
      where: {
        userId,
        parentPathHash: hashPath(parentPath),
        trashedAt: IsNull(),
      },
      select: { name: true },
    });
    return this.nextFreeName(new Set(siblings.map((row) => row.name)), name);
  }

  /** `name` if free in `taken`, else "name (1)", "name (2)", … keeping the extension. */
  protected nextFreeName(
    taken: { has(name: string): boolean },
    name: string,
  ): string {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let i = 1; ; i += 1) {
      const candidate = `${base} (${i})${ext}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  protected isDuplicateKey(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    const code = (error as QueryFailedError & { code?: string }).code;
    return code === 'ER_DUP_ENTRY';
  }

  // --- Path helpers ---------------------------------------------------------

  /** Drops empty and relative segments so a path can't escape the drive. */
  protected normalizePath(path: string): string {
    return path
      .split('/')
      .filter(
        (segment) => segment !== '' && segment !== '.' && segment !== '..',
      )
      .join('/');
  }

  protected joinPath(parentPath: string, name: string): string {
    return parentPath ? `${parentPath}/${name}` : name;
  }

  protected parentOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? '' : path.slice(0, slash);
  }

  protected nameOf(path: string): string {
    const slash = path.lastIndexOf('/');
    return slash === -1 ? path : path.slice(slash + 1);
  }

  /** A path is data, not a pattern: "100%_done" must not match wildcards. */
  protected escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (match) => `\\${match}`);
  }

  protected assertPathLength(path: string): void {
    if (Buffer.byteLength(path, 'utf8') > MAX_PATH_LENGTH) {
      throw new BadRequestException('Path is too long');
    }
  }
}
