import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  // Health endpoint — docker-compose's healthcheck hits GET /.
  @Get()
  getHealth(): string {
    return 'ok';
  }
}
