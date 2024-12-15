import { PrivateKey } from "o1js";

interface ContractConfig {
  contractPrivateKey: PrivateKey;
  contractAddress: string;
}
const privateKey = PrivateKey.random();
export const contract: ContractConfig = {
  contractPrivateKey: PrivateKey.fromBase58(
    "EKEhREnW8b85JQzoa2J9b82HDy6CrTKFvWdEeDP7xrJWAhA4rGYE"
  ),
  contractAddress: "B62qn3Y8r4kjRmEgsYMZR2CMf9cSvM8zBqpUp7tfSxF5JSNSr9rLVvf",
};

export const DEPLOYER = process.env.ADMIN_PRIVATE_KEY;