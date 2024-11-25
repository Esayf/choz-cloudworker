import {
  Cloud,
  zkCloudWorker,
  initBlockchain,
  VerificationData,
  blockchain,
} from "zkcloudworker";
import { initializeBindings, Mina } from "o1js";
import { QuizWorker } from "./src/QuizWorker";
import packageJson from "./package.json";
import { Quiz } from "./src/Quiz";
import { ScoreCalculationLoop } from "./src/ScoreCalculationLoop";
import { WinnersProver } from "./src/WinnersProver";
import { version as o1jsVersion } from "./node_modules/o1js/package.json";
import { version as zkCloudWorkerVersion } from "./node_modules/zkcloudworker/package.json";

export async function zkcloudworker(cloud: Cloud): Promise<zkCloudWorker> {
  console.log(
    `starting worker example version ${
      packageJson.version ?? "unknown"
    } on chain ${cloud.chain}`
  );
    console.log("networkId:", Mina.getNetworkId());
    console.log(`o1js version: ${o1jsVersion}`);
    console.log(`zkCloudWorker version: ${zkCloudWorkerVersion}`);
  await initializeBindings();
  await initBlockchain(cloud.chain);
  return new QuizWorker(cloud);
}

export async function verify(chain: blockchain): Promise<VerificationData> {
  if (chain !== "devnet") throw new Error("Unsupported chain");
  return {
    contract: Quiz,
    programDependencies: [WinnersProver],
    contractDependencies: [],
    address: "B62qrZso6WMaxZPrkDHW9sa7BTtVKjHon6BJxUbN3q6PwdTNQXWvADD",
    chain: "devnet",
  } as VerificationData;
}
