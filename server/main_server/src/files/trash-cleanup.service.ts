import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { FileIndexService } from './file-index.service';
import { TrashService } from './trash.service';

const DAY_MS = 24 * 60 * 60 * 1000;

// How long an unconfirmed upload is left alone before its reservation and
// bytes are dropped. Long enough not to kill a slow, still-running transfer.
const STALE_UPLOAD_MS = DAY_MS;

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);
  private readonly retentionMs: number;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly index: FileIndexService,
    private readonly trash: TrashService,
    config: ConfigService,
  ) {
    const days = Number(config.get<string>('TRASH_RETENTION_DAYS') ?? 30);
    this.retentionMs = (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;
  }

  // Runs once a day over every user: expires old trash, drops uploads that were
  // never confirmed, and reconciles the index against the bucket.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron(): Promise<void> {
    await this.purgeAll();
  }

  async purgeAll(): Promise<number> {
    const users = await this.users.find();
    let purged = 0;
    let adopted = 0;
    let orphanBlobs = 0;
    for (const user of users) {
      try {
        purged += await this.trash.purgeExpiredTrash(user.id, this.retentionMs);
        await this.index.purgeStaleUploads(user.id, STALE_UPLOAD_MS);
        // Adopts anything that appeared in the bucket without going through the
        // app, so it stops being invisible in the drive.
        const reconciled = await this.index.reconcile(user.id);
        adopted += reconciled.adopted;
        orphanBlobs += reconciled.orphanBlobs;
      } catch (error) {
        this.logger.error(
          `Daily maintenance failed for user ${user.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    if (purged > 0) {
      this.logger.log(
        `Trash cleanup removed ${purged} expired entr${purged === 1 ? 'y' : 'ies'}`,
      );
    }
    if (adopted > 0) {
      this.logger.log(`Indexed ${adopted} object(s) found only in storage`);
    }
    // Not deleted automatically: they are user bytes, and a wrong guess here is
    // unrecoverable. Surfaced so they can be dealt with deliberately.
    if (orphanBlobs > 0) {
      this.logger.warn(
        `${orphanBlobs} stored blob(s) have no index row and are costing storage`,
      );
    }
    return purged;
  }
}
