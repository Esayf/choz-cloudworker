import { describe, expect, it } from "@jest/globals";
import {
    PrivateKey,
    PublicKey,
    UInt64,
    setNumberOfWorkers,
    Field,
} from "o1js";
import {
    zkCloudWorkerClient,
    blockchain,
    initBlockchain,
} from "zkcloudworker";
import { zkcloudworker } from "..";
import { Winner } from "../src/WinnersProver";
import { UserAnswers, CorrectAnswers } from "../src/ScoreCalculationLoop";

const { chain, compile, deploy, useLocalCloudWorker } = processArguments();

const api = new zkCloudWorkerClient({
    jwt: useLocalCloudWorker ? "local" : "test_jwt",
    zkcloudworker,
    chain,
});

describe('QuizWorker Tests', () => {
    let deployer: PrivateKey;
    let contractAddress: PublicKey;

    beforeAll(async () => {
        console.log("local chain:", chain);
        const { keys } = await initBlockchain(chain, 2);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        if (keys.length < 2) throw new Error("Invalid keys");
        deployer = keys[0].key;
        contractAddress = PrivateKey.random().toPublicKey();
        setNumberOfWorkers(8);
    });

/*     it('should calculate score through worker', async () => {
        // Create test answers
        const userAnswers = new UserAnswers({
            answers: [Field(1), Field(2), Field(3)]
        });
        const correctAnswers = new CorrectAnswers({
            answers: [Field(1), Field(2), Field(3)]
        });

        const response = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "calculateScore",
            args: JSON.stringify({
                userAnswers: userAnswers.toFields().map(f => f.toString()),
                correctAnswers: correctAnswers.toFields().map(f => f.toString())
            }),
            metadata: "calculate score test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
        expect(result.result.result).toBeDefined();
    }); */

    it('should initialize winner map through worker', async () => {
        const response = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "initWinnerMap",
            args: JSON.stringify({
                contractAddress: contractAddress.toBase58(),
            }),
            metadata: "init winner map test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
        expect(result.result.result).toBeDefined();
    });

    it('should add winner through worker', async () => {
        // First initialize the winner map
        const initResponse = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "initWinnerMap",
            args: JSON.stringify({
                contractAddress: contractAddress.toBase58(),
            }),
            metadata: "init for add winner test",
        });

        const initResult = await api.waitForJobResult({
            jobId: initResponse.jobId!,
            printLogs: true,
        });

        // Now add a winner
        const winner = new Winner({
            publicKey: PrivateKey.random().toPublicKey(),
            reward: UInt64.from(1000),
        });

        const response = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "setWinner",
            args: JSON.stringify({
                winner: winner,
                previousProof: initResult.result.result,
                previousMap: initResult.result.auxiliaryOutput,
            }),
            metadata: "add winner test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
        expect(result.result.result).toBeDefined();
    });

    it('should payout winners through worker', async () => {
        // Create test winners and their proofs
        const winner1 = PrivateKey.random().toPublicKey();
        const winner2 = PrivateKey.random().toPublicKey();
        const winner3 = PrivateKey.random().toPublicKey();

        const response = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "payoutWinners",
            args: JSON.stringify({
                contractAddress: contractAddress.toBase58(),
                winner1: winner1.toBase58(),
                winner1Proof: "mock_proof_1", // You'll need actual proofs here
                winner2: winner2.toBase58(),
                winner2Proof: "mock_proof_2",
                winner3: winner3.toBase58(),
                winner3Proof: "mock_proof_3"
            }),
            metadata: "payout winners test",
        });

        expect(response.success).toBeTruthy();
        const jobId = response.jobId;
        expect(jobId).toBeDefined();

        const result = await api.waitForJobResult({
            jobId: jobId!,
            printLogs: true,
        });

        expect(result.success).toBeTruthy();
        expect(result.result.result).toBeDefined();
    });
});

function processArguments(): {
    chain: blockchain;
    compile: boolean;
    deploy: boolean;
    useLocalCloudWorker: boolean;
} {
    function getArgument(arg: string): string | undefined {
        const argument = process.argv.find((a) => a.startsWith("--" + arg));
        return argument?.split("=")[1];
    }

    const chainName = getArgument("chain") ?? "local";
    const shouldDeploy = getArgument("deploy") ?? "true";
    const compile = getArgument("compile");
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
        compile: compile === "true" || shouldDeploy === "true",
        deploy: shouldDeploy === "true",
        useLocalCloudWorker: cloud
            ? cloud === "local"
            : chainName === "local" || chainName === "lightnet",
    };
}