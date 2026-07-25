import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { StorageModule } from '../storage/storage.module';
import { TrashCleanupService } from './trash-cleanup.service';

@Module({
  imports: [TypeOrmModule.forFeature([User]), StorageModule],
  providers: [TrashCleanupService],
})
export class TrashCleanupModule {}
