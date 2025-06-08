import { object, z } from "zod";

export default function (input: any): boolean {
  try {
    const text = z.string({ message: "config must be a string" }).parse(input);
    if (text.startsWith('vmess://') || text.startsWith('vless://')) return true;

    const parsedJson = JSON.parse(text);
    return parsedJson !== null && typeof parsedJson === 'object';
  } catch (error) {
    console.error(error);
    return false;
  }
}