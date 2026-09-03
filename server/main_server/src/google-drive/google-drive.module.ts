import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FilesModule } from '../files/files.module';
import { GoogleDriveService } from './google-drive.service';
import { DriveImportService } from './drive-import.service';
import { GoogleDriveController } from './google-drive.controller';

/**
 * Google Drive integration: reading a user's Drive (GoogleDriveService) and
 * copying picked files into this drive (DriveImportService).
 *
 * It depends on FilesModule (for FileIndexService, where imported files are
 * recorded) one-way — FilesModule knows nothing about this module — so there's
 * no circular dependency.
 */
@Module({
  imports: [FilesModule, StorageModule, AuthModule],
  controllers: [GoogleDriveController],
  providers: [GoogleDriveService, DriveImportService],
})
export class GoogleDriveModule {}
