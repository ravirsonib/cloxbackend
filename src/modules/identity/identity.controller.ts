import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  updateLocaleSchema,
  type UpdateLocaleInput,
} from '../../shared/types';
import { IdentityService } from './identity.service';

@ApiTags('identity')
@Controller('identity')
export class IdentityController {
  constructor(private readonly identityService: IdentityService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Identity module status' })
  status() {
    return { module: 'identity', status: 'ready', milestone: 'M1' };
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiTags('identity', 'driver-app')
  @ApiOperation({ summary: 'Current principal profile (SHR-PROF-01)' })
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.identityService.getMe(principal);
  }

  @Patch('me/locale')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiTags('identity', 'driver-app')
  @ApiOperation({ summary: 'Update preferred UI / notification locale' })
  updateLocale(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(updateLocaleSchema)) body: UpdateLocaleInput,
  ) {
    return this.identityService.updateLocale(principal, body);
  }
}
