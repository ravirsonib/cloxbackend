import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
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
  @ApiOperation({ summary: 'Current principal profile (SHR-PROF-01)' })
  me(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.identityService.getMe(principal);
  }
}
