import {
  TransactionBuilder,
  Keypair,
  Networks,
  Operation,
  Asset,
  Account,
  BASE_FEE,
} from '@stellar/stellar-sdk'
import {
  buildMultisigEnvelope,
  addSignature,
  assembleTransaction,
  validateThreshold,
  decodeDecoratedSignature,
  MultisigEnvelope,
} from '../../../src/stellar/multisig'

describe('Multisig Transaction Assembly (#667)', () => {
  const signer1 = Keypair.random()
  const signer2 = Keypair.random()
  const destination = Keypair.random()

  function createBaseTransaction(): { baseTxXdr: string; txHash: Buffer } {
    const account = new Account(signer1.publicKey(), '100')
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: destination.publicKey(),
          asset: Asset.native(),
          amount: '100',
        })
      )
      .setTimeout(300)
      .build()

    return {
      baseTxXdr: tx.toXDR(),
      txHash: tx.hash(),
    }
  }

  describe('Envelope lifecycle and signature collection', () => {
    it('creates an envelope with PENDING status', () => {
      const expiresAt = new Date(Date.now() + 60000)
      const envelope = buildMultisigEnvelope(signer1.publicKey(), 2, expiresAt)

      expect(envelope.id).toBeDefined()
      expect(envelope.publicKey).toBe(signer1.publicKey())
      expect(envelope.threshold).toBe(2)
      expect(envelope.signatures).toEqual([])
      expect(envelope.status).toBe('PENDING')
      expect(envelope.expiresAt).toEqual(expiresAt)
    })

    it('transitions to COLLECTING when signatures < threshold', () => {
      const expiresAt = new Date(Date.now() + 60000)
      let envelope = buildMultisigEnvelope(signer1.publicKey(), 2, expiresAt)

      envelope = addSignature(envelope, 'dummy-signature-1')
      expect(envelope.signatures).toHaveLength(1)
      expect(envelope.status).toBe('COLLECTING')
    })

    it('transitions to READY when threshold is met', () => {
      const expiresAt = new Date(Date.now() + 60000)
      let envelope = buildMultisigEnvelope(signer1.publicKey(), 2, expiresAt)

      envelope = addSignature(envelope, 'sig1')
      envelope = addSignature(envelope, 'sig2')
      expect(envelope.signatures).toHaveLength(2)
      expect(envelope.status).toBe('READY')
    })

    it('rejects adding a signature to an expired envelope', () => {
      const expiredAt = new Date(Date.now() - 1000)
      const envelope = buildMultisigEnvelope(signer1.publicKey(), 2, expiredAt)

      expect(() => addSignature(envelope, 'sig1')).toThrow('Envelope expired')
    })

    it('validates on-chain threshold against envelope', () => {
      const envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )
      expect(validateThreshold(envelope, 2)).toBe(true)
      expect(validateThreshold(envelope, 3)).toBe(false)
    })
  })

  describe('assembleTransaction with two-signer envelope fixture', () => {
    it('decodes and attaches collected signatures from a two-signer envelope fixture', () => {
      const { baseTxXdr, txHash } = createBaseTransaction()

      // Signer 1 and Signer 2 produce decorated signatures
      const decSig1 = signer1.signDecorated(txHash)
      const decSig2 = signer2.signDecorated(txHash)

      const sig1Xdr = decSig1.toXDR('base64')
      const sig2Xdr = decSig2.toXDR('base64')

      let envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )
      envelope = addSignature(envelope, sig1Xdr)
      envelope = addSignature(envelope, sig2Xdr)
      expect(envelope.status).toBe('READY')

      // Assemble transaction
      const assembledXdr = assembleTransaction(envelope, baseTxXdr)
      expect(typeof assembledXdr).toBe('string')
      expect(assembledXdr).not.toEqual(baseTxXdr)

      // Deserialize and verify attached signatures
      const restoredTx = TransactionBuilder.fromXDR(
        assembledXdr,
        Networks.TESTNET
      )
      expect(restoredTx.signatures).toHaveLength(2)

      // Verify hints match signers' public keys (last 4 bytes)
      const hint1 = signer1.rawPublicKey().subarray(28, 32)
      const hint2 = signer2.rawPublicKey().subarray(28, 32)

      expect(restoredTx.signatures[0].hint().equals(hint1)).toBe(true)
      expect(restoredTx.signatures[1].hint().equals(hint2)).toBe(true)

      // Cryptographically verify signatures against transaction hash
      const verified1 = Keypair.fromPublicKey(signer1.publicKey()).verify(
        txHash,
        restoredTx.signatures[0].signature()
      )
      const verified2 = Keypair.fromPublicKey(signer2.publicKey()).verify(
        txHash,
        restoredTx.signatures[1].signature()
      )
      expect(verified1).toBe(true)
      expect(verified2).toBe(true)
    })

    it('attaches signatures provided as JSON { publicKey, signature }', () => {
      const { baseTxXdr, txHash } = createBaseTransaction()

      const rawSig1 = signer1.sign(txHash)
      const rawSig2 = signer2.sign(txHash)

      const jsonSig1 = JSON.stringify({
        publicKey: signer1.publicKey(),
        signature: rawSig1.toString('base64'),
      })
      const jsonSig2 = JSON.stringify({
        publicKey: signer2.publicKey(),
        signature: rawSig2.toString('base64'),
      })

      let envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )
      envelope = addSignature(envelope, jsonSig1)
      envelope = addSignature(envelope, jsonSig2)

      const assembledXdr = assembleTransaction(envelope, baseTxXdr)
      const restoredTx = TransactionBuilder.fromXDR(
        assembledXdr,
        Networks.TESTNET
      )

      expect(restoredTx.signatures).toHaveLength(2)
      expect(
        Keypair.fromPublicKey(signer1.publicKey()).verify(
          txHash,
          restoredTx.signatures[0].signature()
        )
      ).toBe(true)
      expect(
        Keypair.fromPublicKey(signer2.publicKey()).verify(
          txHash,
          restoredTx.signatures[1].signature()
        )
      ).toBe(true)
    })

    it('attaches signatures provided as "publicKey:signature" string', () => {
      const { baseTxXdr, txHash } = createBaseTransaction()

      const rawSig1 = signer1.sign(txHash).toString('base64')
      const colonSig1 = `${signer1.publicKey()}:${rawSig1}`

      const decSig2 = signer2.signDecorated(txHash).toXDR('base64')

      let envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )
      envelope = addSignature(envelope, colonSig1)
      envelope = addSignature(envelope, decSig2)

      const assembledXdr = assembleTransaction(envelope, baseTxXdr)
      const restoredTx = TransactionBuilder.fromXDR(
        assembledXdr,
        Networks.TESTNET
      )

      expect(restoredTx.signatures).toHaveLength(2)
    })

    it('avoids attaching duplicate signatures if transaction already has one', () => {
      const { baseTxXdr, txHash } = createBaseTransaction()

      const decSig1 = signer1.signDecorated(txHash)
      const decSig2 = signer2.signDecorated(txHash)

      // Base tx already signed with signer1
      const preSignedTx = TransactionBuilder.fromXDR(
        baseTxXdr,
        Networks.TESTNET
      )
      preSignedTx.signatures.push(decSig1)
      const preSignedXdr = preSignedTx.toXDR()

      let envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )
      envelope = addSignature(envelope, decSig1.toXDR('base64'))
      envelope = addSignature(envelope, decSig2.toXDR('base64'))

      const assembledXdr = assembleTransaction(envelope, preSignedXdr)
      const restoredTx = TransactionBuilder.fromXDR(
        assembledXdr,
        Networks.TESTNET
      )

      // Should have 2 signatures, not 3
      expect(restoredTx.signatures).toHaveLength(2)
    })

    it('throws if envelope status is not READY', () => {
      const { baseTxXdr } = createBaseTransaction()
      const envelope = buildMultisigEnvelope(
        signer1.publicKey(),
        2,
        new Date(Date.now() + 60000)
      )

      expect(() => assembleTransaction(envelope, baseTxXdr)).toThrow(
        'Envelope not ready for submission'
      )
    })

    it('throws if envelope has expired', () => {
      const { baseTxXdr } = createBaseTransaction()
      const envelope: MultisigEnvelope = {
        id: 'test-id',
        publicKey: signer1.publicKey(),
        threshold: 2,
        signatures: ['sig1', 'sig2'],
        status: 'READY',
        expiresAt: new Date(Date.now() - 5000),
      }

      expect(() => assembleTransaction(envelope, baseTxXdr)).toThrow(
        'Envelope expired'
      )
    })

    it('throws if signatures count is less than threshold', () => {
      const { baseTxXdr } = createBaseTransaction()
      const envelope: MultisigEnvelope = {
        id: 'test-id',
        publicKey: signer1.publicKey(),
        threshold: 2,
        signatures: ['sig1'],
        status: 'READY', // Inconsistent state
        expiresAt: new Date(Date.now() + 60000),
      }

      expect(() => assembleTransaction(envelope, baseTxXdr)).toThrow(
        'Insufficient signatures: expected at least 2, got 1'
      )
    })
  })

  describe('decodeDecoratedSignature', () => {
    it('decodes instantiated xdr.DecoratedSignature objects directly', () => {
      const { txHash } = createBaseTransaction()
      const decSig = signer1.signDecorated(txHash)
      const decoded = decodeDecoratedSignature(decSig)
      expect(decoded.hint().equals(decSig.hint())).toBe(true)
    })

    it('throws on unsupported signature formats', () => {
      expect(() => decodeDecoratedSignature(12345 as any)).toThrow(
        'Unsupported signature format'
      )
    })
  })
})
