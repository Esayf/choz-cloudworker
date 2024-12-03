import { PrivateKey } from "o1js";
import env from "../env.json";

interface ContractConfig {
  contractPrivateKey: PrivateKey;
  contractAddress: string;
}
const privateKey = PrivateKey.random();
export const contract: ContractConfig = {
  contractPrivateKey: PrivateKey.fromBase58(
    "EKErezLMeFXhXAicSES9fiRsq6X4VMb1XmZ57L4qzcGMR9VfqcGr"
  ),
  contractAddress: "B62qoz8c3U1DMMyQcRwciARwyKMrayfbtkZMQBUiAsSjkLEyVJtf4CP",
};

export const DEPLOYER = process.env.ADMIN_PRIVATE_KEY;