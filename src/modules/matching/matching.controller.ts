import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppRole,
  proposalSubmitSchema,
  type ProposalSubmitInput,
} from '../../shared/types';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MatchingService } from './matching.service';

@ApiTags('matching')
@Controller('matching')
export class MatchingController {
  constructor(private readonly matchingService: MatchingService) {}

  @Get('_status')
  @ApiOperation({ summary: 'Matching module status' })
  status() {
    return { module: 'matching', status: 'ready', milestone: 'M6' };
  }

  @Get('board')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Carrier job board (filtered, net 70% hint)' })
  board(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.matchingService.listBoard(principal);
  }

  @Post('bids')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Submit proposal (vehicle + driver + amount)' })
  placeBid(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(proposalSubmitSchema)) body: ProposalSubmitInput,
  ) {
    return this.matchingService.submitProposal(principal, body);
  }
}
