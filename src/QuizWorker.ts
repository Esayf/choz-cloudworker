import {
    zkCloudWorker,
    Cloud,
    fee,
    sleep,
    deserializeFields,
    fetchMinaAccount,
    accountBalanceMina,
} from "zkcloudworker";
import {
    verify,
    type JsonProof,
    VerificationKey,
    PublicKey,
    Mina,
    PrivateKey,
    AccountUpdate,
    Cache,
    UInt64,
    Bool,
    Field,
    MerkleMap,
    Proof,
} from "o1js";
import { adminKey, Quiz, QuizState, WinnerState } from "./Quiz";
import { ScoreCalculationLoop, UserAnswers, CorrectAnswers, ScoreProof } from "./ScoreCalculationLoop";
import { Winner, WinnerInput, WinnerOutput, WinnersProof, WinnersProver } from "./WinnersProver";

export class QuizWorker extends zkCloudWorker {
    static quizVerificationKey: VerificationKey | undefined = undefined;
    static scoreCalculationVerificationKey: VerificationKey | undefined = undefined;
    static winnerVerificationKey: VerificationKey | undefined = undefined;
    readonly cache: Cache;

    constructor(cloud: Cloud) {
        super(cloud);
        this.cache = Cache.FileSystem(this.cloud.cache);
    }

    private async compile(): Promise<void> {
        try {

            if(QuizWorker.scoreCalculationVerificationKey === undefined) {
                console.time("compiled ScoreCalculationLoop");
                QuizWorker.scoreCalculationVerificationKey = (
                    await ScoreCalculationLoop.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled ScoreCalculationLoop");
            }

            if (QuizWorker.winnerVerificationKey === undefined) {
                console.time("compiled WinnersProver");
                QuizWorker.winnerVerificationKey = (
                    await WinnersProver.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled WinnersProver");
            }

            if (QuizWorker.quizVerificationKey === undefined) {
                console.time("compiled Quiz");
                QuizWorker.quizVerificationKey = (
                    await Quiz.compile({
                        cache: this.cache,
                    })
                ).verificationKey;
                console.timeEnd("compiled Quiz");
            }
            console.timeEnd("compiled");
        } catch (error) {
            console.error("Error in compile, restarting container", error);
            await this.cloud.forceWorkerRestart();
            throw error;
        }
    }

    public async calculateScore(transaction: string): Promise<string | undefined> {
        const msg = `score calculated`;
        console.time(msg);
        const args = JSON.parse(transaction);

        const userAnswers: UserAnswers = args.userAnswers as UserAnswers;

        const correctAnswers: CorrectAnswers = args.correctAnswers as CorrectAnswers;
        await this.compile();
        if (QuizWorker.scoreCalculationVerificationKey === undefined)
            throw new Error("verificationKey is undefined");

        if(userAnswers.answers.length < 80) {
            for(let i = userAnswers.answers.length; i < 80; i++) {
                userAnswers.answers.push(Field(0));
                correctAnswers.answers.push(Field(7));
            }
        }

        const proof = await ScoreCalculationLoop.calculateScore(userAnswers, correctAnswers);
        console.timeEnd(msg);
        console.log("score", proof.proof.publicOutput);
        return JSON.stringify(proof.proof.toJSON(), null, 2);
    }

    private async initWinnerMap(contractAddress: PublicKey): Promise<string> {
        await this.compile();
        const deployer = await fetchMinaAccount({ publicKey: adminKey.toPublicKey(), force: true });
        if(deployer.account === undefined)
            throw new Error("deployer is undefined");
        const sender = deployer.account.publicKey;
        const proof = await WinnersProver.init(new WinnerInput({
            contractAddress: contractAddress,
            previousWinner: new Winner({
                publicKey: PublicKey.empty(),
                reward: UInt64.from(0),
            }),
            winner: new Winner({
                publicKey: PublicKey.empty(),
                reward: UInt64.from(0),
            }),
            totalPaidReward: UInt64.from(0),
            previousRoot: new MerkleMap().getRoot()
        }), contractAddress);
        const zkApp = new Quiz(contractAddress);
        
        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "init winner map" },
            async () => {
                await zkApp.setWinnersRoot(proof.auxiliaryOutput.root);
            }
        );
        await tx.prove();
        tx.sign([adminKey]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: adminKey.toPublicKey().toString(),
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });
        return txSent?.hash ? JSON.stringify(proof.auxiliaryOutput, null, 2) : "Error sending transaction";
    }

    private async addWinner(args: {
        winner: Winner;
        previousProof: JsonProof;
        previousMap: any;
    }): Promise<string> {
        await this.compile();
        const winnerPrevProof: {
            proof: Proof<WinnerInput, WinnerOutput>;
            auxiliaryOutput: undefined;
        } = {
            proof: await WinnersProof.fromJSON(args.previousProof),
            auxiliaryOutput: args.previousMap
        };
        const proof = await WinnersProver.addWinner(new WinnerInput({
            contractAddress: winnerPrevProof.proof.publicOutput.contractAddress,
            previousWinner: winnerPrevProof.proof.publicOutput.winner,
            winner: args.winner,
            totalPaidReward: winnerPrevProof.proof.publicOutput.totalPaidReward,
            previousRoot: winnerPrevProof.proof.publicOutput.newRoot
        }), args.previousMap, winnerPrevProof.proof);
        return JSON.stringify(proof.proof.toJSON(), null, 2);
    }

    public async execute(transactions: string[]): Promise<string | undefined> {
        if (this.cloud.args === undefined)
            throw new Error("this.cloud.args is undefined");
        const args = JSON.parse(this.cloud.args);
        console.log("args", args);
        switch (this.cloud.task) {
            case "initQuiz":
                return await this.initQuiz(args);

            case "initWinnerMap":
                return await this.initWinnerMap(PublicKey.fromBase58(args.contractAddress));
            
            case "calculateScore":
                return await this.calculateScore(JSON.stringify(args));

            case "setWinner":
                return await this.addWinner(args);

            case "payoutWinners":
                return await this.payoutWinners(args);

            default:
                throw new Error(`Unknown task: ${this.cloud.task}`);
        }
    }

    private async initQuiz(args: {
        contractAddress: string;
        secretKey: string;
        duration: string;
        startDate: string;
        totalRewardPoolAmount: string;
        rewardPerWinner: string;
    }): Promise<string> {
        await this.compile();
        const sender = adminKey.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);

        const rewardPerWinner = UInt64.from(args.rewardPerWinner);
        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "init quiz" },
            async () => {
                await zkApp.initQuizState(
                    Field(args.secretKey),
                    UInt64.from(args.duration),
                    UInt64.from(args.startDate),
                    UInt64.from(args.totalRewardPoolAmount),
                    rewardPerWinner,
                );
            }
        );

        await tx.prove();
        tx.sign([adminKey]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: adminKey.toPublicKey().toString(),
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }

    private async payoutWinners(args: {
        contractAddress: string;
        winner1: string;
        winner1Proof: JsonProof;
        winner2: string;
        winner2Proof: JsonProof;
        winner3: string;
        winner3Proof: JsonProof;
    }): Promise<string> {
        await this.compile();
        const sender = adminKey.toPublicKey();
        const contractAddress = PublicKey.fromBase58(args.contractAddress);
        const zkApp = new Quiz(contractAddress);

        const tx = await Mina.transaction(
            { sender, fee: await fee(), memo: "payout winners" },
            async () => {
                await zkApp.payoutByTwo(
                    await WinnersProof.fromJSON(args.winner1Proof),
                    await WinnersProof.fromJSON(args.winner2Proof),
                );
            }
        );

        await tx.prove();
        tx.sign([adminKey]);

        const txSent = await tx.send();
        await this.cloud.releaseDeployer({
            publicKey: adminKey.toPublicKey().toString(),
            txsHashes: txSent?.hash ? [txSent.hash] : [],
        });

        return txSent?.hash ?? "Error sending transaction";
    }
} 