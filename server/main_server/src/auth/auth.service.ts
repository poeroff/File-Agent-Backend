import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { StorageService } from '../storage/storage.service';
import { GoogleSignInDto } from './dto/google-signin.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly storage: StorageService,
  ) {}

  async signInWithGoogle(dto: GoogleSignInDto) {
    if (!dto.providerAccountId || !dto.email) {
      throw new BadRequestException('providerAccountId and email are required');
    }

    const existing = await this.users.findOne({
      where: { providerAccountId: dto.providerAccountId },
    });

    let user: User;
    if (!existing) {
      user = await this.users.save(
        this.users.create({
          providerAccountId: dto.providerAccountId,
          email: dto.email,
          name: dto.name ?? null,
          image: dto.image ?? null,
        }),
      );

      // Brand-new user: provision their personal S3 folder. If that fails,
      // roll back the row so the next login retries cleanly instead of
      // leaving a user with no storage (existing users skip this entirely,
      // keeping steady-state logins fast).
      try {
        await this.storage.ensureUserFolder(user.id);
      } catch {
        // Storage provisioning failed (StorageService already logged why) —
        // undo the just-created account so it isn't half-created, and return
        // a clean 503 the frontend can surface as a network error.
        await this.users.remove(user);
        throw new ServiceUnavailableException(
          'Failed to provision user storage',
        );
      }
    } else {
      existing.email = dto.email;
      existing.name = dto.name ?? existing.name;
      existing.image = dto.image ?? existing.image;
      user = await this.users.save(existing);
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
    });

    return { accessToken, user };
  }

  async findById(id: string) {
    return this.users.findOne({ where: { id } });
  }
}
