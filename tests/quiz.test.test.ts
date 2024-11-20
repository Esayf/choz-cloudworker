import { describe, expect, it } from "@jest/globals";
import {
    PrivateKey,
    PublicKey,
    UInt64,
    setNumberOfWorkers,
    Field,
    Cache,
    Mina,
    AccountUpdate,
    VerificationKey,
} from "o1js";
import {
    zkCloudWorkerClient,
    blockchain,
    initBlockchain,
    fee,
    fetchMinaAccount,
    sleep,
    Memory,
} from "zkcloudworker";
import { zkcloudworker } from "..";
import { Winner } from "../src/WinnersProver";
import { UserAnswers, CorrectAnswers } from "../src/ScoreCalculationLoop";
import { adminKey, Quiz } from "../src/Quiz";
import { WinnersProver } from "../src/WinnersProver";
import { ScoreCalculationLoop } from "../src/ScoreCalculationLoop";
import packageJson from "../package.json";

const { name: repo, author: developer } = packageJson;
const { chain, compile, deploy, useLocalCloudWorker } = processArguments();

const api = new zkCloudWorkerClient({
    jwt: useLocalCloudWorker ? "local" : "test_jwt",
    zkcloudworker,
    chain,
});

describe('QuizWorker Tests', () => {
    let deployer: PrivateKey;
    let sender: PublicKey;
    let contractAddress: PublicKey;
    let quizVerificationKey: VerificationKey;
    let winnersVerificationKey: VerificationKey;
    let scoreCalculationVerificationKey: VerificationKey;
    let blockchainInitialized = false;

     beforeAll(async () => {
        console.log("local chain:", chain);
        const { keys } = await initBlockchain(chain, 2);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        if (keys.length < 2) throw new Error("Invalid keys");
        deployer = keys[0].key;
        sender = deployer.toPublicKey();
        contractAddress = PrivateKey.random().toPublicKey();
        setNumberOfWorkers(8);

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
                { sender: wallet, fee: "100000000", memo: "payment" },
                async () => {
                  const senderUpdate = AccountUpdate.createSigned(wallet);
                  senderUpdate.balance.subInPlace(1000000000);
                  senderUpdate.send({
                    to: adminKey.toPublicKey(),
                    amount: 500_000_000_000,
                  });
                }
              );
              transaction.sign([wallet.key]);
              await sendTx(transaction, "block producer account creation");
              const transaction2 = await Mina.transaction(
                { sender: wallet, fee: "100000000", memo: "payment" },
                async () => {
                  const senderUpdate = AccountUpdate.createSigned(wallet);
                  senderUpdate.send({
                    to: deployer.toPublicKey(),
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
        blockchainInitialized = true;
    });

    if (compile) {
        it('should analyze and compile contracts', async () => {
            expect(blockchainInitialized).toBe(true);
            console.log("Analyzing contracts methods...");
            console.time("methods analyzed");
            
            const methods = [
                {
                    name: "Quiz",
                    result: await Quiz.analyzeMethods(),
                },
                {
                    name: "WinnersProver",
                    result: await WinnersProver.analyzeMethods(),
                },
                {
                    name: "ScoreCalculationLoop",
                    result: await ScoreCalculationLoop.analyzeMethods(),
                }
            ];
            
            console.timeEnd("methods analyzed");
            
            // Analyze contract sizes
            const maxRows = 2 ** 16;
            for (const contract of methods) {
                const size = Object.values(contract.result).reduce(
                    (acc, method) => acc + method.rows,
                    0
                );
                const percentage = Math.round(((size * 100) / maxRows) * 100) / 100;

                console.log(
                    `Method's total size for ${contract.name} is ${size} rows (${percentage}% of max ${maxRows} rows)`
                );
                for (const method in contract.result) {
                    console.log(method, `rows:`, (contract.result as any)[method].rows);
                }
            }

            // Compile contracts
            console.time("compiled");
            console.log("Compiling contracts...");
            const cache: Cache = Cache.FileSystem("./cache");

            console.time("WinnersProver compiled");
            winnersVerificationKey = (await WinnersProver.compile({ cache })).verificationKey;
            console.timeEnd("WinnersProver compiled");

            console.time("ScoreCalculationLoop compiled");
            scoreCalculationVerificationKey = (await ScoreCalculationLoop.compile({ cache })).verificationKey;
            console.timeEnd("ScoreCalculationLoop compiled");

            console.time("Quiz compiled");
            quizVerificationKey = (await Quiz.compile({ cache })).verificationKey;
            console.timeEnd("Quiz compiled");
            console.timeEnd("compiled");
            Memory.info("compiled");
        });
    }

    if (deploy) {
        it('should deploy Quiz contract', async () => {
            expect(blockchainInitialized).toBe(true);
            console.log(`Deploying Quiz contract...`);

            await fetchMinaAccount({ publicKey: sender, force: true });

            const zkApp = new Quiz(contractAddress);
            const tx = await Mina.transaction(
                { sender, fee: await fee(), memo: "deploy quiz" },
                async () => {
                    AccountUpdate.fundNewAccount(sender);
                    await zkApp.deploy({});
                }
            );

            await tx.prove();
            tx.sign([deployer]);
            await sendTx(tx, "deploy");
            Memory.info("deployed");
        });
    }

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