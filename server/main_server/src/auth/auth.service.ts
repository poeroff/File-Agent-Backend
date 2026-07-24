import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { GoogleSignInDto } from './dto/google-signin.dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
  ) {}

  async signInWithGoogle(dto: GoogleSignInDto) {
    if (!dto.providerAccountId || !dto.email) {
      throw new BadRequestException('providerAccountId and email are required');
    }

    let user = await this.users.findOne({
      where: { providerAccountId: dto.providerAccountId },
    });

    if (!user) {
      user = this.users.create({
        providerAccountId: dto.providerAccountId,
        email: dto.email,
        name: dto.name ?? null,
        image: dto.image ?? null,
      });
    } else {
      user.email = dto.email;
      user.name = dto.name ?? user.name;
      user.image = dto.image ?? user.image;
    }
    user = await this.users.save(user);

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
