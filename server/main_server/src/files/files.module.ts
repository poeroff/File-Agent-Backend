import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FilesController } from './files.controller';

@Module({
  // AuthModule provides JwtAuthGuard; StorageModule provides StorageService.
  imports: [AuthModule, StorageModule],
  controllers: [FilesController],
})
export class FilesModule {}
