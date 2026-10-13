import { address, type Address } from "@solana/kit";

export const TOKEN_WRAP_PROGRAM_IDS = {
  devnet: address("58yEtWEhrsRery3w1kZiTXdWofY6efvxmeAZwLrexgQ"),
  mainnet: address("TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR")
} as const;

export function getTokenWrapProgramId(
  network: keyof typeof TOKEN_WRAP_PROGRAM_IDS
): Address {
  return TOKEN_WRAP_PROGRAM_IDS[network];
}
