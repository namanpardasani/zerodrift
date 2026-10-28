import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { bootstrap, createHealthModule } from '@zerodrift/common';
import { loadConfig } from '@zerodrift/config';

const config = loadConfig({}, { SERVICE_NAME: 'chaos-controller', PORT: '3006', ...process.env });

@Module({ imports: [createHealthModule(config.SERVICE_NAME)] })
class AppModule {}

bootstrap(AppModule, config.PORT, config.SERVICE_NAME).catch((err) => {
  console.error(err);
  process.exit(1);
});
