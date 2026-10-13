import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { bodyParserErrorHandler } from "./common/body-parser-error.middleware";
import { ProblemDetailsFilter } from "./common/problem-details.filter";
import { requestContext } from "./common/request-context.middleware";
import type { Env } from "./config/env";

// Shared by main.ts and the tests, so tests exercise the real HTTP pipeline.
// The app must be created with { bodyParser: false }; JSON parsing is configured here.
export function configureApp(app: INestApplication, env: Env): void {
  app.useLogger(app.get(Logger));
  app.use(requestContext);
  app.use(helmet());
  app.enableCors({ origin: env.CORS_ALLOWED_ORIGINS, credentials: true });
  app.use(json({ limit: "100kb" }));
  app.use(bodyParserErrorHandler);
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.enableShutdownHooks();

  const openApi = new DocumentBuilder()
    .setTitle("Inventory Service")
    .setDescription("Stock levels and reservations. See docs/api.md for semantics.")
    .setVersion("1.0.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, openApi), {
    jsonDocumentUrl: "docs-json",
  });
}
