import { NestFactory } from '@nestjs/core';
import type { Server } from 'http';
import { json, urlencoded, type RequestHandler } from 'express';
import { AppModule } from './app.module';

const PROXY_PATH = '/storage/proxy';

/** Body parsers must not touch /storage/proxy — its body is streamed as-is. */
const skipProxy =
  (parser: RequestHandler): RequestHandler =>
  (req, res, next) =>
    req.path.startsWith(PROXY_PATH) ? next() : parser(req, res, next);

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(skipProxy(json()));
  app.use(skipProxy(urlencoded({ extended: true })));
  app.enableCors({
    // Comma-separated so the deployed frontend and localhost can both call in.
    origin: (process.env.FRONTEND_URL ?? 'http://localhost:3000').split(','),
    credentials: true,
    // Multipart uploads read each part's ETag off the /storage/proxy response.
    exposedHeaders: ['ETag', 'Content-Disposition', 'Content-Length'],
  });
  // ponytail: uploads stream through /storage/proxy, so a single request can
  // outlive node's 5-minute default. Headers still time out; only the body wait
  // is unbounded.
  (app.getHttpServer() as Server).requestTimeout = 0;
  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
