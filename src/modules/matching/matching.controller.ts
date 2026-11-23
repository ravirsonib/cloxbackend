import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
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

const bidMinimumQuerySchema = z.object({
  vehicleId: z.string().uuid(),
});

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

  @Get('jobs/:jobId/bid-minimum')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({
    summary: 'Preview carrier payout minimum for a job + vehicle (matches bid submit floors)',
  })
  previewBidMinimum(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
    @Query(new ZodValidationPipe(bidMinimumQuerySchema)) query: z.infer<typeof bidMinimumQuerySchema>,
  ) {
    return this.matchingService.previewBidMinimum(principal, jobId, query.vehicleId);
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

  @Post('proposals/:id/withdraw')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Withdraw submitted proposal to unlock carrier vehicle/driver' })
  withdrawProposal(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.matchingService.withdrawProposal(principal, id);
  }

  @Post('jobs/:jobId/withdraw')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.TRANSPORT_COMPANY)
  @ApiOperation({ summary: 'Withdraw submitted proposal for a job by jobId' })
  withdrawByJobId(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ) {
    return this.matchingService.withdrawProposalByJobId(principal, jobId);
  }
}
