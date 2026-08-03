import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { swaggerConfig } from '../src/transport/api.contracts';

/**
 * Emits the OpenAPI document and a self-contained HTML rendering of it from the running Nest
 * application. The spec is generated from the decorators, never hand-written — a hand-written
 * spec is a second source of truth that starts drifting on the first change.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  await app.close();

  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/openapi.json', JSON.stringify(document, null, 2));
  writeFileSync(
    'docs/openapi.html',
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Multi-platform comments — API</title>
    <style>body { margin: 0 }</style>
  </head>
  <body>
    <!-- The spec is embedded, so the page needs the network only for Redoc's renderer itself. -->
    <script id="spec" type="application/json">${JSON.stringify(document)}</script>
    <div id="redoc"></div>
    <script src="https://unpkg.com/redoc@2/bundles/redoc.standalone.js"></script>
    <script>
      Redoc.init(JSON.parse(document.getElementById('spec').textContent), {}, document.getElementById('redoc'));
    </script>
  </body>
</html>
`,
  );
}

void main();
