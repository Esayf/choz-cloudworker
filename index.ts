import {
  Cloud,
  zkCloudWorker,
  initBlockchain,
  VerificationData,
  blockchain,
} from "zkcloudworker";
import { initializeBindings } from "o1js";
import { QuizWorker } from "./src/QuizWorker";
import packageJson from "./package.json";
import { Quiz } from "./src/Quiz";
import { ScoreCalculationLoop } from "./src/ScoreCalculationLoop";

export async function zkcloudworker(cloud: Cloud): Promise<zkCloudWorker> {
  console.log(
    `starting worker example version ${
      packageJson.version ?? "unknown"
    } on chain ${cloud.chain}`
  );
  await initializeBindings();
  await initBlockchain(cloud.chain);
  return new QuizWorker(cloud);
}

export async function verify(chain: blockchain): Promise<VerificationData> {
  if (chain !== "devnet") throw new Error("Unsupported chain");
  return {
    contract: Quiz,
    programDependencies: [],
    contractDependencies: [],
    address: "B62qrZso6WMaxZPrkDHW9sa7BTtVKjHon6BJxUbN3q6PwdTNQXWvADD",
    chain: "devnet",
  } as VerificationData;
}
