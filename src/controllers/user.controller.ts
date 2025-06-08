import prisma from "../prisma";

export async function getUser(telegramId: number) {
  return await prisma.user.upsert({
    where: { telegramId },
    create: { telegramId },
    update: {}
  })
}

export async function getAllAdmins() {
  return await prisma.user.findMany({ where: { isAdmin: true } });
}