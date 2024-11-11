import { describe, expect, it } from "@jest/globals";
import {
    PrivateKey,
    Mina,
    AccountUpdate,
    PublicKey,
    UInt64,
    Field,
    Cache,
    UInt8,
    Bool,
} from "o1js";
import { Quiz, QuizState, WinnerState } from "../src/Quiz";
import { ScoreCalculationLoop, UserAnswers, CorrectAnswers } from "../src/ScoreCalculationLoop";
import { QuizWorker } from "../src/QuizWorker";
import { zkcloudworker } from "..";
import {
    zkCloudWorkerClient,
    blockchain,
    sleep,
    fetchMinaAccount,
    fee,
    initBlockchain,
} from "zkcloudworker";
import { adminKey } from "../src/Quiz";
const {
    chain,
    compile,
    deploy,
    one,
    many,
    send,
    files,
    encrypt,
    useLocalCloudWorker,
  } = processArguments();
  
  const api = new zkCloudWorkerClient({
    jwt: "local",
    zkcloudworker,
    chain,
  });
describe('QuizWorker Tests', () => {
    const JWT = process.env.WORKER_JWT || "test_jwt";
    const developer = "test_dev";
    const repo = "test_repo";
    let deployer: PrivateKey;
    beforeAll(async () => {
        console.log("local chain:", "local");
        const { keys } = await initBlockchain("local", 2);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        if (keys.length < 2) throw new Error("Invalid keys");
        deployer = keys[0].key;
    });

    it('should initialize quiz state through worker', async () => {
        const contractPrivateKey = PrivateKey.random();
        const contractAddress = contractPrivateKey.toPublicKey();

        const response = await api.execute({
            developer,
            repo,
            transactions: [],
            task: "initQuiz",
            args: JSON.stringify({
                contractAddress: contractAddress.toBase58(),
                secretKey: "123456",
                duration: "3600",
                startDate: Date.now().toString(),
                totalRewardPoolAmount: "1000000000"
            }),
            metadata: "init quiz test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
    });

    it('should set winner through worker', async () => {
        const contractPrivateKey = PrivateKey.random();
        const contractAddress = contractPrivateKey.toPublicKey();
        const winner = PrivateKey.random().toPublicKey();

        const response = await api.execute({
            developer,
            repo,
            transactions: [],
            task: "setWinner",
            args: JSON.stringify({
                contractAddress: contractAddress.toBase58(),
                winner: winner.toBase58(),
                amount: "1000",
                finishDate: Date.now().toString(),
            }),
            metadata: "set winner test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
    });

    // Add more worker tests as needed
});

function processArguments(): {
    chain: blockchain;
    compile: boolean;
    deploy: boolean;
    one: boolean;
    many: boolean;
    send: boolean;
    files: boolean;
    encrypt: boolean;
    useLocalCloudWorker: boolean;
} {
    function getArgument(arg: string): string | undefined {
        const argument = process.argv.find((a) => a.startsWith("--" + arg));
        return argument?.split("=")[1];
    }

    const chainName = getArgument("chain") ?? "local";
    const shouldDeploy = getArgument("deploy") ?? "true";
    const compile = getArgument("compile");
    const one = getArgument("one") ?? "true";
    const many = getArgument("many") ?? "true";
    const send = getArgument("send") ?? "false";
    const files = getArgument("files") ?? "false";
    const encrypt = getArgument("encrypt") ?? "false";
    const cloud = getArgument("cloud");

    if (
        chainName !== "local" &&
        chainName !== "devnet" &&
        chainName !== "lightnet" &&
        chainName !== "zeko"
    )
        throw new Error("Invalid chain name");
    return {
        chain: chainName as blockchain,
        compile: compile === "true" || shouldDeploy === "true" || send === "true",
        deploy: shouldDeploy === "true",
        one: one === "true",
        many: many === "true",
        send: send === "true",
        files: files === "true",
        encrypt: encrypt === "true",
        useLocalCloudWorker: cloud
            ? cloud === "local"
            : chainName === "local" || chainName === "lightnet",
    };
}