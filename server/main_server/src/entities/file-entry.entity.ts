import { createHash } from 'crypto';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export type FileEntryType = 'file' | 'folder';

/**
 * `pending` rows exist between handing out an upload URL and the upload
 * finishing. They're hidden from listings, and reconciliation deletes the ones
 * whose upload never completed.
 */
export type FileEntryStatus = 'pending' | 'ready';

/** Longest path we accept, matching S3's own 1024-byte key limit. */
export const MAX_PATH_LENGTH = 1024;

/**
 * Where a file *appears* in the user's drive, kept separately from where its
 * bytes actually live (`blobKey`).
 *
 * S3 has no rename: changing a key means copying the whole object (and objects
 * over 5GB can't even be copied in one call). Keeping the visible path here
 * instead means organising — moving, renaming, trashing, restoring — is a row
 * update, so it is instant and free no matter how large the file is, and the
 * bytes are written exactly once.
 */
@Entity()
// One live row per path. Paths can be up to 1024 chars, which is far past
// MySQL's index key limit, so the unique/lookup indexes are on hashes of the
// path instead of the path itself.
@Unique('uq_file_entry_path', ['userId', 'pathHash'])
@Index('idx_file_entry_children', ['userId', 'parentPathHash'])
@Index('idx_file_entry_trash', ['userId', 'trashRootId'])
export class FileEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The owner's user id — the `sub` of the backend JWT. Every query starts
   * here, so it carries an index of its own; `blobKey` deliberately has none,
   * since a 1024-char column would blow past MySQL's 3072-byte index limit and
   * the only lookups by blob are one-per-upload inside a single user's rows.
   */
  @Column({ length: 64 })
  @Index('idx_file_entry_user')
  userId!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: FileEntryType;

  /**
   * Path relative to the user's drive root, without a trailing slash even for
   * folders (e.g. "사진/2026" or "사진/2026/여행.jpg"). NULL while the row is in
   * the trash, so a trashed item stops occupying its old name — MySQL allows
   * repeated NULLs in a unique index, which is what makes that work.
   */
  @Column({ type: 'varchar', length: MAX_PATH_LENGTH, nullable: true })
  path!: string | null;

  /** sha256 of `path`; NULL mirrors `path` being NULL. See the class comment. */
  @Column({ type: 'char', length: 64, nullable: true })
  pathHash!: string | null;

  /** Parent folder path ("" at the root), NULL while trashed. */
  @Column({ type: 'varchar', length: MAX_PATH_LENGTH, nullable: true })
  parentPath!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  parentPathHash!: string | null;

  /** Display name, kept even while trashed so the trash can list it. */
  @Column({ type: 'varchar', length: 512 })
  name!: string;

  /**
   * S3 key holding the bytes, relative to the user's prefix — normally
   * `blobs/{uuid}`. Never changes once written, and is NULL for folders (which
   * have no bytes). Files imported from the old layout keep their original
   * path-shaped key: what matters is that the key is opaque to the app, not
   * that it has a particular shape.
   */
  @Column({ type: 'varchar', length: MAX_PATH_LENGTH, nullable: true })
  blobKey!: string | null;

  // MySQL BIGINT comes back as a string through the driver, so it's mapped with
  // an explicit transformer to keep `size` a number everywhere in the app.
  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number | null) => Number(value ?? 0),
    },
  })
  size!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  contentType!: string | null;

  @Column({ type: 'datetime', precision: 3 })
  modifiedAt!: Date;

  @Column({ type: 'varchar', length: 16, default: 'ready' })
  status!: FileEntryStatus;

  @Column({ type: 'datetime', precision: 3, nullable: true })
  trashedAt!: Date | null;

  /** Path to restore to. Holds what `path` was when the row was trashed. */
  @Column({ type: 'varchar', length: MAX_PATH_LENGTH, nullable: true })
  trashedFromPath!: string | null;

  /**
   * Groups a trashed subtree under the single row the user actually trashed:
   * that row points at itself, its descendants point at it. The trash view
   * lists roots, and restore/delete act on a whole group.
   */
  @Column({ type: 'uuid', nullable: true })
  trashRootId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

/** Index key for a path (see FileEntry's comment on why paths aren't indexed). */
export function hashPath(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}
