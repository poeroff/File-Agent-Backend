import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MinioAdminService } from './minio-admin.service';

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private readonly minioAdmin: MinioAdminService) {}

  /** Free/used/total bytes on the NAS disk backing MinIO. */
  @Get('usage')
  usage() {
    return this.minioAdmin.getDiskUsage();
  }
}
