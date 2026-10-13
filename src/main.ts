import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";
import { configureApp } from "./configure-app";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(env), {
    bufferLogs: true,
    bodyParser: false,
  });
  app.disable("x-powered-by");
  configureApp(app, env);
  await app.listen(env.PORT);
}

void bootstrap();
