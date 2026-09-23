import { loadEnv } from './env';
loadEnv();

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { assertSecurityConfig, security } from './common/security.config';

async function bootstrap() {
  // Checked before anything listens: a production deploy that would carry credentials
  // in cleartext aborts here rather than serving traffic. See common/security.config.ts.
  const sec = security();
  assertSecurityConfig(sec);

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Behind the edge nginx (and the SPA nginx) the socket peer is a proxy, not the user.
  // Without this req.ip is the proxy for everyone, which blunts per-IP throttling and
  // records the wrong address in the audit log. Set TRUST_PROXY to the number of proxies
  // that append to X-Forwarded-For — trusting more hops than exist lets a client spoof it.
  app.set('trust proxy', sec.trustProxy);

  app.use(helmet({
    hsts: sec.hstsMaxAge > 0
      ? { maxAge: sec.hstsMaxAge, includeSubDomains: true, preload: false }
      : false,
    // The API only ever returns JSON; the SPA's own policy is served by nginx.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'same-origin' },
  }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');

  // AR-09: an explicit allowlist, or no CORS at all. Reflecting the caller's Origin while
  // allowing credentials would let any site the user visits call this API as them.
  app.enableCors({
    origin: sec.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT || '3000', 10);
  await app.listen(port);
  new Logger('Bootstrap').log(
    `EngPro API listening on :${port} ` +
    `(DEPLOY_ENV=${sec.env}, cookieSecure=${sec.cookieSecure}, trustProxy=${sec.trustProxy}, ` +
    `cors=${sec.corsOrigins === false ? 'same-origin only' : sec.corsOrigins.join(' ')})`,
  );
}
bootstrap();
