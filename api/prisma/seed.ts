import { PrismaClient, AdminRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.SEED_SUPER_ADMIN_EMAIL ?? 'abc@example.com').toLowerCase();
  const name = process.env.SEED_SUPER_ADMIN_NAME ?? 'CLOX Super Admin';

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {
      name,
      role: AdminRole.SUPER_ADMIN,
      active: true,
    },
    create: {
      email,
      name,
      role: AdminRole.SUPER_ADMIN,
      active: true,
    },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded Super Admin: ${admin.email} (${admin.id})`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
