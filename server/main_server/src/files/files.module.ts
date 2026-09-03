import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/user.entity';
import { FileEntry } from '../entities/file-entry.entity';
import { FileIndexService } from './file-index.service';
import { TrashService } from './trash.service';
import { FilesController } from './files.controller';
import { TrashCleanupService } from './trash-cleanup.service';
import { StorageController } from '../storage/storage.controller';

@Module({
  // AuthModule provides JwtAuthGuard; StorageModule provides StorageService.
  // User is here for TrashCleanupService, which walks every user daily.
  imports: [
    TypeOrmModule.forFeature([FileEntry, User]),
    AuthModule,
    StorageModule,
  ],
  // StorageController lives here (not StorageModule) because it needs
  // JwtAuthGuard from AuthModule, which itself imports StorageModule.
  controllers: [FilesController, StorageController],
  providers: [FileIndexService, TrashService, TrashCleanupService],
  // Exported so the Google Drive module's import feature can record files in
  // the index without a circular dependency back into this module.
  exports: [FileIndexService],
})
export class FilesModule {}
