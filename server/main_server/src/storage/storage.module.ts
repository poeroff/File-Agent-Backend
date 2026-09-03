import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { MinioAdminService } from './minio-admin.service';

@Module({
  providers: [StorageService, MinioAdminService],
  exports: [StorageService, MinioAdminService],
})
export class StorageModule {}
