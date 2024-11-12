import { 
    Field, 
    Struct, 
    ZkProgram, 
    Provable, 
    PublicKey,
    Poseidon,
    MerkleMapWitness,
    SelfProof,
    MerkleMap
} from 'o1js';
import { ScoreCalculationLoop } from './ScoreCalculationLoop';

// Define the proof type from ScoreCalculationLoop
export class ScoreProof extends ZkProgram.Proof(ScoreCalculationLoop) {}

// Structure to hold winner data
export class Winner extends Struct({
    publicKey: PublicKey,
    score: Field,
}) {
    hash(): Field {
        return Poseidon.hash(this.publicKey.toFields().concat([this.score]));
    }
}

// Input for the winners proof
export class WinnerBatchInput extends Struct({
    currentMerkleRoot: Field,    // Current root before adding these winners
    winner1: Winner,
    winner2: Winner,
    winner3: Winner,
    witness1: MerkleMapWitness,  // Witness for winner1's position in current tree
    witness2: MerkleMapWitness,  // Witness for winner2's position after adding winner1
    witness3: MerkleMapWitness,  // Witness for winner3's position after adding winner1 and winner2
}) {}

// Output after processing winners
export class WinnerBatchOutput extends Struct({
    previousMerkleRoot: Field,   // Root before changes
    newMerkleRoot: Field,        // Root after adding all three winners
    winner1: Winner,
    winner2: Winner,
    winner3: Winner,
}) {}

export const WinnersProver = ZkProgram({
    name: "winners-prover",
    publicInput: WinnerBatchInput,
    publicOutput: WinnerBatchOutput,
    methods: {
        init: {
            privateInputs: [ScoreProof, ScoreProof, ScoreProof],
            async method(
                input: WinnerBatchInput,
                scoreProof1: ScoreProof,
                scoreProof2: ScoreProof,
                scoreProof3: ScoreProof,
            ) {
                // For init, verify currentMerkleRoot is zero
                input.currentMerkleRoot.assertEquals(Field(0));

                // Verify all score proofs
                scoreProof1.verify();
                scoreProof2.verify();
                scoreProof3.verify();

                // Verify scores match the proofs
                input.winner1.score.assertEquals(scoreProof1.publicOutput);
                input.winner2.score.assertEquals(scoreProof2.publicOutput);
                input.winner3.score.assertEquals(scoreProof3.publicOutput);

                // Process winners sequentially
                const [rootAfterWinner1] = input.witness1.computeRootAndKey(input.winner1.hash());
                const [rootAfterWinner2] = input.witness2.computeRootAndKey(input.winner2.hash());
                const [finalRoot] = input.witness3.computeRootAndKey(input.winner3.hash());

                return {publicOutput: new WinnerBatchOutput({
                    previousMerkleRoot: Field(0),
                    newMerkleRoot: finalRoot,
                    winner1: input.winner1,
                    winner2: input.winner2,
                    winner3: input.winner3,
                })};
            }
        },

        addWinners: {
            privateInputs: [SelfProof, ScoreProof, ScoreProof, ScoreProof],
            async method(
                input: WinnerBatchInput,
                previousProof: SelfProof<WinnerBatchInput, WinnerBatchOutput>,
                scoreProof1: ScoreProof,
                scoreProof2: ScoreProof,
                scoreProof3: ScoreProof,
            ) {
                // Verify previous proof
                previousProof.verify();

                // Verify current root matches previous proof's output
                input.currentMerkleRoot.assertEquals(previousProof.publicOutput.newMerkleRoot);

                // Verify all score proofs
                scoreProof1.verify();
                scoreProof2.verify();
                scoreProof3.verify();

                // Verify scores match the proofs
                input.winner1.score.assertEquals(scoreProof1.publicOutput);
                input.winner2.score.assertEquals(scoreProof2.publicOutput);
                input.winner3.score.assertEquals(scoreProof3.publicOutput);

                // Verify the starting root matches
                const [currentRoot] = input.witness1.computeRootAndKey(Field(0));
                currentRoot.assertEquals(input.currentMerkleRoot);

                // Process winners sequentially
                const [rootAfterWinner1] = input.witness1.computeRootAndKey(input.winner1.hash());
                const [rootAfterWinner2] = input.witness2.computeRootAndKey(input.winner2.hash());
                const [finalRoot] = input.witness3.computeRootAndKey(input.winner3.hash());

                return {
                    publicOutput: new WinnerBatchOutput({
                        previousMerkleRoot: input.currentMerkleRoot,
                        newMerkleRoot: finalRoot,
                        winner1: input.winner1,
                        winner2: input.winner2,
                        winner3: input.winner3,
                })};
            }
        }
    }
});

export class WinnersProof extends ZkProgram.Proof(WinnersProver) {}

// Helper function to generate witnesses and input for the prover
export function createWinnerBatchInput(
    currentMerkleRoot: Field,
    merkleMap: MerkleMap,
    winners: Winner[]
): WinnerBatchInput {
    if (winners.length !== 3) throw new Error("Must provide exactly 3 winners");

    // Get witness for winner1's position in current tree
    const witness1 = merkleMap.getWitness(winners[0].publicKey.toFields()[0]);
    
    // Add winner1 and get witness for winner2
    merkleMap.set(winners[0].publicKey.toFields()[0], winners[0].hash());
    const witness2 = merkleMap.getWitness(winners[1].publicKey.toFields()[0]);
    
    // Add winner2 and get witness for winner3
    merkleMap.set(winners[1].publicKey.toFields()[0], winners[1].hash());
    const witness3 = merkleMap.getWitness(winners[2].publicKey.toFields()[0]);

    return new WinnerBatchInput({
        currentMerkleRoot,
        winner1: winners[0],
        winner2: winners[1],
        winner3: winners[2],
        witness1,
        witness2,
        witness3
    });
}
