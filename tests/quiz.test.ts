import { describe, expect, it } from "@jest/globals";
import {
    PrivateKey,
    PublicKey,
    UInt64,
    setNumberOfWorkers,
    Field,
    Mina,
    AccountUpdate,
} from "o1js";
import {
    zkCloudWorkerClient,
    blockchain,
    initBlockchain,
    fetchMinaAccount,
    sleep,
} from "zkcloudworker";
import { zkcloudworker } from "..";
import { Winner } from "../src/WinnersProver";
import { UserAnswers, CorrectAnswers } from "../src/ScoreCalculationLoop";
import { adminKey } from "../src/Quiz";

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

        setNumberOfWorkers(8);

        const { keys } = await initBlockchain(chain, 2);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        if (keys.length < 2) throw new Error("Invalid keys");
        deployer = keys[0].key;
        const deployerAccountUpdateTransaction = await Mina.transaction(
            { sender: deployer.toPublicKey(), fee: "100000000", memo: "payment" },
            async () => {
                AccountUpdate.fundNewAccount(adminKey.toPublicKey());
            }
        );
        deployerAccountUpdateTransaction.sign([deployer]);
        await sendTx(deployerAccountUpdateTransaction, "fund deployer account");
        sleep(10000);
        process.env.DEPLOYER_PRIVATE_KEY = deployer.toBase58();
        process.env.DEPLOYER_PUBLIC_KEY = deployer.toPublicKey().toBase58();
        contractAddress = PrivateKey.random().toPublicKey();
        try {
            await fetchMinaAccount({ publicKey: adminKey.toPublicKey() });
            if (!Mina.hasAccount(adminKey.toPublicKey())) {
                console.log("Block producer account not found, creating...");

                const wallet = keys[1];
                console.log("wallet:", wallet.toBase58());

                const transaction = await Mina.transaction(
                    { sender: wallet, fee: 100_000_000, memo: "payment" },
                    async () => {
                        const senderUpdate = AccountUpdate.createSigned(wallet);
                        senderUpdate.balance.subInPlace(500_000_000_000);
                        senderUpdate.send({
                            to: adminKey.toPublicKey(),
                            amount: 500_000_000_000,
                        });
                    }
                );
                transaction.sign([wallet.key]);
                await sendTx(transaction, "block producer account creation");
            }
        } catch (error: any) {
            console.error("Error in block producer account creation:", error);
            return;
        }
    });

    it('should calculate score through worker', async () => {
        // Create test answers
        const userAnswers = new UserAnswers([Field(1), Field(2), Field(3)]);
        const correctAnswers = new CorrectAnswers([Field(1), Field(2), Field(3)]);

        const response = await api.execute({
            developer: "test_dev",
            repo: "test_repo",
            transactions: [],
            task: "calculateScore",
            args: JSON.stringify({
                userAnswers: userAnswers,
                correctAnswers: correctAnswers
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
    });

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
                winner1Proof: "mock_proof_1", // You'll need actual proofs here
                winner2Proof: "mock_proof_2",
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

async function sendTx(
    tx: Mina.Transaction<false, true> | Mina.Transaction<true, true>,
    description?: string
) {
    try {
        let txSent;
        let sent = false;
        while (!sent) {
            txSent = await tx.safeSend();
            if (txSent.status === "pending") {
                sent = true;
                console.log(
                    `${description ?? ""} tx sent: hash: ${txSent.hash} status: ${txSent.status}`
                );
            } else if (chain === "zeko") {
                console.log("Retrying Zeko tx");
                await sleep(10000);
            } else {
                console.log(
                    `${description ?? ""} tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status}`
                );
                return "Error sending transaction";
            }
        }

        if (txSent === undefined) throw new Error("txSent is undefined");
        if (txSent.errors.length > 0) {
            console.error(
                `${description ?? ""} tx error: hash: ${txSent.hash} status: ${txSent.status} errors: ${txSent.errors}`
            );
        }

        if (txSent.status === "pending") {
            console.log(`Waiting for tx inclusion...`);
            const txIncluded = await txSent.safeWait();
            console.log(
                `${description ?? ""} tx included into block: hash: ${txIncluded.hash} status: ${txIncluded.status}`
            );
        }
    } catch (error) {
        if (chain !== "zeko") console.error("Error sending tx", error);
    }
    if (chain !== "local") await sleep(10000);
}