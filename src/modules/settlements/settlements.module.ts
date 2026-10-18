import { Module } from '@nestjs/common';
import { SettlementsController } from './settlements.controller';

@Module({
  controllers: [SettlementsController],
})
export class SettlementsModule {}
