import { PrismaService } from './prisma.service';

describe('PrismaService construct leftover', () => {
  it('constructs with connected=false before init', () => {
    const service = new PrismaService();
    expect(service.isConnected()).toBe(false);
  });
});
