import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { StorageService } from '../storage/storage.service';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class TrashCleanupService {
  private readonly logger = new Logger(TrashCleanupService.name);
  private readonly retentionMs: number;

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    const days = Number(config.get<string>('TRASH_RETENTION_DAYS') ?? 30);
    this.retentionMs = (Number.isFinite(days) && days > 0 ? days : 30) * DAY_MS;
  }

  // Runs once a day; purges every user's trash entries older than the retention.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCron(): Promise<void> {
    await this.purgeAll();
  }

  async purgeAll(): Promise<number> {
    const users = await this.users.find();
    let total = 0;
    for (const user of users) {
      try {
        total += await this.storage.purgeExpiredTrash(
          user.id,
          this.retentionMs,
        );
      } catch (error) {
        this.logger.error(
          `Failed to purge trash for user ${user.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    if (total > 0) {
      this.logger.log(
        `Trash cleanup removed ${total} expired entr${total === 1 ? 'y' : 'ies'}`,
      );
    }
    return total;
  }
}
