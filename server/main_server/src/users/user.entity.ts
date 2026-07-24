import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity()
@Unique(['providerAccountId'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  providerAccountId!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  name: string | null = null;

  @Column({ type: 'varchar', nullable: true })
  image: string | null = null;

  @CreateDateColumn()
  createdAt!: Date;
}
