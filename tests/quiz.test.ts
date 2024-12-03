import { describe, expect, it } from "@jest/globals";
import {
    PrivateKey,
    PublicKey,
    UInt64,
    setNumberOfWorkers,
    Field,
    Mina,
    AccountUpdate,
    Cache,
    VerificationKey
} from "o1js";
import {
    zkCloudWorkerClient,
    blockchain,
    initBlockchain,
    fetchMinaAccount,
    fee,
    Memory,
    sleep,
    serializeIndexedMap,
    accountBalanceMina,
    serializeTransaction,
} from "zkcloudworker";
import { zkcloudworker } from "..";
import { Winner, WinnersProver } from "../src/WinnersProver";
import { UserAnswers, CorrectAnswers, ScoreCalculationLoop } from "../src/ScoreCalculationLoop";
import { contract, DEPLOYER } from "./config";
import { Quiz } from "../src/Quiz";
import { QuizWorker } from "../src/QuizWorker";
import { JWT } from "../env.json";
import { name, author, version } from "../package.json";
import Client from "mina-signer"
const { chain, compile, deploy, useLocalCloudWorker, one } = processArguments();

const api = new zkCloudWorkerClient({
    jwt: useLocalCloudWorker ? "local" : JWT,
    zkcloudworker,
    chain
});
let contractPrivateKey = contract.contractPrivateKey;
let contractPublicKey = contractPrivateKey.toPublicKey();
let deployer: PrivateKey;
let blockchainInitialized: boolean = false;
let sender: PublicKey;
let winnerUser1: PublicKey;
let winnerUser2: PublicKey;
let winnerUser3: PublicKey;
let winnersVerificationKey: VerificationKey;
let scoreCalculationVerificationKey: VerificationKey;
let quizVerificationKey: VerificationKey;
setNumberOfWorkers(8);

describe('QuizWorker Tests', () => {

    it(`should initialize blockchain`, async () => {

        if (chain === "local" || chain === "lightnet") {
            console.log("local chain:", chain);
            const { keys } = await initBlockchain(chain, 2);
            expect(keys.length).toBeGreaterThanOrEqual(2);
            if (keys.length < 2) throw new Error("Invalid keys");
            deployer = PrivateKey.fromBase58(process.env.ADMIN_PRIVATE_KEY!);
            sender = deployer.toPublicKey();
            winnerUser1 = PrivateKey.random().toPublicKey();
            winnerUser2 = PrivateKey.random().toPublicKey();
            winnerUser3 = PrivateKey.random().toPublicKey();
            const accountUpdateTx = await Mina.transaction({
                sender: keys[0].key.toPublicKey(), fee: await fee(), memo: "fund new accounts"
            }, async () => {
                const au = AccountUpdate.fundNewAccount(keys[0].key.toPublicKey(), 4);
                au.send({ to: sender, amount: 2e10 });
                au.send({ to: winnerUser1, amount: 2e10 });
                au.send({ to: winnerUser2, amount: 2e10 });
                au.send({ to: winnerUser3, amount: 2e10 });
            });
            accountUpdateTx.sign([keys[0].key]);
            await sendTx(accountUpdateTx, "fund new account");
        } else {
            console.log("non-local chain:", chain);
            await initBlockchain(chain);
            deployer = PrivateKey.fromBase58(DEPLOYER!);
        }
        process.env.DEPLOYER_PRIVATE_KEY = deployer.toBase58();
        process.env.DEPLOYER_PUBLIC_KEY = deployer.toPublicKey().toBase58();
        console.log("contract address:", contract.contractAddress);
        sender = deployer.toPublicKey();
        console.log("sender:", sender.toBase58());
        console.log("Sender balance:", await accountBalanceMina(sender));
        console.log("Winner1 balance:", await accountBalanceMina(winnerUser1));
        console.log("Winner2 balance:", await accountBalanceMina(winnerUser2));
        console.log("Winner3 balance:", await accountBalanceMina(winnerUser3));
        console.log("Winner1 account:", await fetchMinaAccount({ publicKey: winnerUser1, force: true }));
        console.log("Winner2 account:", await fetchMinaAccount({ publicKey: winnerUser2, force: true }));
        console.log("Winner3 account:", await fetchMinaAccount({ publicKey: winnerUser3, force: true }));
        expect(deployer).toBeDefined();
        expect(sender).toBeDefined();
        expect(deployer.toPublicKey().toBase58()).toBe(sender.toBase58());
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
            console.log("quizVerificationKey: ", quizVerificationKey.data);
            console.log("quizVerificationKey hash: ", quizVerificationKey.hash.toString());
            console.timeEnd("Quiz compiled");
            console.timeEnd("compiled");
            Memory.info("compiled");
        });
    }
    if (deploy) {
        it(`should deploy contract`, async () => {
            expect(blockchainInitialized).toBe(true);
            console.log(`Deploying contract...`);

            await fetchMinaAccount({ publicKey: sender, force: true });
            /*             const buildDeployQuizResponse = await api.execute({
                            developer: author,
                            repo: name,
                            transactions: [],
                            task: "buildDeployQuizTx",
                            args: JSON.stringify({ contractAddress: contractPublicKey.toBase58(), sender: sender.toBase58() }),
                            metadata: "deploy quiz test",
                        });
                        const deployQuizResult = await api.waitForJobResult({
                            jobId: buildDeployQuizResponse.jobId!,
                            printLogs: true,
                        });
                        expect(deployQuizResult.success).toBeTruthy();
                        expect(deployQuizResult.result.result).toBeDefined(); */
            const nonce = Number(Mina.getAccount(sender).nonce.toBigint());
            const privateKeyRandom = PrivateKey.random();
            console.log("privateKeyRandom", privateKeyRandom.toBase58());
            console.log("contractAddress", privateKeyRandom.toPublicKey().toBase58());
            const zkApp = new Quiz(PublicKey.fromBase58(privateKeyRandom.toPublicKey().toBase58()));
            const tx = await Mina.transaction(
                {
                    sender: sender, fee: 1e8, memo: "deploy quizbu", nonce: nonce
                },
                async () => {
                    AccountUpdate.fundNewAccount(sender);
                    await zkApp.deploy({ verificationKey: quizVerificationKey });
                    await zkApp.initQuizState(Field(1), UInt64.from(10 * 100 * 60), UInt64.from(1732277050678), UInt64.from(6e5), UInt64.from(10 * 100 * 60));
                }
            );
            tx.sign([deployer, privateKeyRandom]);
            const serializedTransaction = serializeTransaction(tx);
            const transaction = tx.toJSON();
            const txJSON = JSON.parse(transaction);
            let signedData = JSON.stringify({ zkappCommand: txJSON });
            console.log("signedAuroData", signedData);
            const proveAndSendDeployQuizResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "proveAndSendDeployQuizTx",
                args: JSON.stringify({ contractAddress: privateKeyRandom.toPublicKey().toBase58(), serializedTransaction: serializedTransaction, signedData: signedData, secretKey: Field(1).toString(), startDate: "1732277050678", totalRewardPoolAmount: UInt64.from(6e5).toString(), rewardPerWinner: UInt64.from(10 * 100 * 60).toString(), duration: UInt64.from(10 * 100 * 60).toString() }),
                metadata: "prove and send deploy quiz tx test",
            });
            const deployQuizTxResult = await api.waitForJobResult({
                jobId: proveAndSendDeployQuizResponse.jobId!,
                printLogs: true,
            });
            expect(deployQuizTxResult.success).toBeTruthy();
            expect(deployQuizTxResult.result.result).toBeDefined();
            await sleep(10000);
            contract.contractAddress = privateKeyRandom.toPublicKey().toBase58()
            contract.contractPrivateKey = privateKeyRandom
            contractPrivateKey = privateKeyRandom
            Memory.info("deployed");
        });
    }

    if (one) {
        /*         it('should calculate score through worker', async () => {
                    // Create test answers
                    const userAnswers = new UserAnswers([Field(1), Field(2), Field(3)]);
                    const correctAnswers = new CorrectAnswers([Field(1), Field(2), Field(3)]);
        
                    const response = await api.execute({
                        developer: author,
                        repo: name,
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
                }); */

        it('should payout one winner through worker', async () => {
            const initResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "initWinnerMap",
                args: JSON.stringify({
                    contractAddress: contract.contractAddress,
                }),
                metadata: "init for add winner test",
            });

            const initResult = await api.waitForJobResult({
                jobId: initResponse.jobId!,
                printLogs: true,
            });

            // Now add a winner
            const winner = new Winner({
                publicKey: winnerUser3,
                reward: UInt64.from(1000),
            });
            const initWinnerResult = JSON.parse(initResult.result.result);
            const addWinnerResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "addWinner",
                args: JSON.stringify({
                    winner: { publicKey: winner.publicKey.toBase58(), reward: winner.reward.toString() },
                    previousProof: initWinnerResult.proof,
                    serializedStringPreviousMap: initWinnerResult.auxiliaryOutput,
                }, null, 2),
                metadata: "add winner test",
            });
            expect(addWinnerResponse.success).toBeTruthy();
            const addWinnerJobId = addWinnerResponse.jobId;
            expect(addWinnerJobId).toBeDefined();

            const addWinnerResult = await api.waitForJobResult({
                jobId: addWinnerJobId!,
                printLogs: true,
            });

            expect(addWinnerResult.success).toBeTruthy();
            expect(addWinnerResult.result.result).toBeDefined();
            const addFirstWinnerResultJson = JSON.parse(addWinnerResult.result.result);
            const response = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "payoutOneWinner",
                args: JSON.stringify({
                    contractAddress: contract.contractAddress,
                    winner: winner.publicKey.toBase58(),
                    proof: addFirstWinnerResultJson.proof,
                }),
                metadata: "payout one winner test",
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
            await fetchMinaAccount({ publicKey: sender, force: true });
            await fetchMinaAccount({ publicKey: contract.contractAddress, force: true });
            /*             //First initialize the quiz state
                        const initQuizResponse = await api.execute({
                            developer: author,
                            repo: name,
                            transactions: [],
                            task: "buildInitQuizTx",
                            args: JSON.stringify({
                                contractAddress: contract.contractAddress,
                                sender: sender.toBase58(),
                            }),
                            metadata: "init quiz state for payout test",
                        });
            
                        const initQuizResult = await api.waitForJobResult({
                            jobId: initQuizResponse.jobId!,
                            printLogs: true,
                        });
            
                        expect(initQuizResult.success).toBeTruthy();
                        expect(initQuizResult.result.result).toBeDefined();
            
                        const initQuizResultJson = initQuizResult.result.result;
                        console.log("initQuizResultJson", initQuizResultJson);
                        const signedTx = initQuizResultJson.sign([deployer]);
                        console.log("signedTx", signedTx);
                        const txHash = await sendTx(signedTx, "prove and send init quiz tx");
                        console.log("txHash", txHash);
                        */
            // initialize the winner map
            const initResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "initWinnerMap",
                args: JSON.stringify({
                    contractAddress: contract.contractAddress,
                }),
                metadata: "init for add winner test",
            });

            const initResult = await api.waitForJobResult({
                jobId: initResponse.jobId!,
                printLogs: true,
            });

            // Now add a winner
            const winner = new Winner({
                publicKey: winnerUser1,
                reward: UInt64.from(1000),
            });
            const initWinnerResult = JSON.parse(initResult.result.result);
            const addWinnerResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "addWinner",
                args: JSON.stringify({
                    winner: { publicKey: winner.publicKey.toBase58(), reward: winner.reward.toString() },
                    previousProof: initWinnerResult.proof,
                    serializedStringPreviousMap: initWinnerResult.auxiliaryOutput,
                }, null, 2),
                metadata: "add winner test",
            });
            expect(addWinnerResponse.success).toBeTruthy();
            const addWinnerJobId = addWinnerResponse.jobId;
            expect(addWinnerJobId).toBeDefined();

            const addWinnerResult = await api.waitForJobResult({
                jobId: addWinnerJobId!,
                printLogs: true,
            });

            expect(addWinnerResult.success).toBeTruthy();
            expect(addWinnerResult.result.result).toBeDefined();

            // Now add second winner
            const secondWinner = new Winner({
                publicKey: winnerUser2,
                reward: UInt64.from(1000),
            });
            const addFirstWinnerResultJson = JSON.parse(addWinnerResult.result.result);
            const addSecondWinnerResponse = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "addWinner",
                args: JSON.stringify({
                    winner: { publicKey: secondWinner.publicKey.toBase58(), reward: secondWinner.reward.toString() },
                    previousProof: addFirstWinnerResultJson.proof,
                    serializedStringPreviousMap: addFirstWinnerResultJson.auxiliaryOutput,
                }, null, 2),
                metadata: "add second winner test",
            });
            expect(addSecondWinnerResponse.success).toBeTruthy();
            const addSecondWinnerJobId = addSecondWinnerResponse.jobId;
            expect(addSecondWinnerJobId).toBeDefined();

            const addSecondWinnerResult = await api.waitForJobResult({
                jobId: addSecondWinnerJobId!,
                printLogs: true,
            });

            expect(addSecondWinnerResult.success).toBeTruthy();
            expect(addSecondWinnerResult.result.result).toBeDefined();

            const secondWinnerResult = JSON.parse(addSecondWinnerResult.result.result)
            const response = await api.execute({
                developer: author,
                repo: name,
                transactions: [],
                task: "payoutWinners",
                args: JSON.stringify({
                    contractAddress: contract.contractAddress,
                    winner1: winner.publicKey.toBase58(),
                    winner2: secondWinner.publicKey.toBase58(),
                    winner1Proof: addFirstWinnerResultJson.proof,
                    winner2Proof: secondWinnerResult.proof,
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
    }
});


function processArguments(): {
    chain: blockchain;
    compile: boolean;
    deploy: boolean;
    one: boolean;
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
            if (txSent.status == "pending") {
                sent = true;
                console.log(
                    `${description ?? ""} tx sent: hash: ${txSent.hash} status: ${txSent.status
                    }`
                );
            } else if (chain === "zeko") {
                console.log("Retrying Zeko tx");
                await sleep(10000);
            } else {
                console.log(
                    `${description ?? ""} tx NOT sent: hash: ${txSent?.hash} status: ${txSent?.status
                    }`
                );
                console.log("Errors:", txSent.errors);
                return "Error sending transaction";
            }
        }
        if (txSent === undefined) throw new Error("txSent is undefined");
        if (txSent.errors.length > 0) {
            console.error(
                `${description ?? ""} tx error: hash: ${txSent.hash} status: ${txSent.status
                }  errors: ${txSent.errors}`
            );
        }

        if (txSent.status === "pending") {
            console.log(`Waiting for tx inclusion...`);
            const txIncluded = await txSent.safeWait();
            console.log(
                `${description ?? ""} tx included into block: hash: ${txIncluded.hash
                } status: ${txIncluded.status}`
            );
        }
    } catch (error) {
        if (chain !== "zeko") console.error("Error sending tx", error);
    }
    if (chain !== "local") await sleep(10000);
}