import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/user.entity';
import { FileEntry } from './file-entry.entity';
import { DriveImportService } from './drive-import.service';
import { FileIndexService } from './file-index.service';
import { GoogleDriveService } from './google-drive.service';
import { FilesController } from './files.controller';
import { TrashCleanupService } from './trash-cleanup.service';

@Module({
  // AuthModule provides JwtAuthGuard; StorageModule provides StorageService.
  // User is here for TrashCleanupService, which walks every user daily.
  imports: [
    TypeOrmModule.forFeature([FileEntry, User]),
    AuthModule,
    StorageModule,
  ],
  controllers: [FilesController],
  providers: [
    FileIndexService,
    TrashCleanupService,
    GoogleDriveService,
    DriveImportService,
  ],
})
export class FilesModule {}
