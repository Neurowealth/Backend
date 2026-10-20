import { getAccount } from '../src/stellar/client'

async function main(): Promise<void> {
  const signer = process.env.STELLAR_AGENT_PUBLIC_KEY?.trim()
  if (!signer)
    throw new Error(
      'STELLAR_AGENT_PUBLIC_KEY is required (public G... address only)'
    )

  const publicKeys = [
    signer,
    ...(process.env.STELLAR_SPONSOR_PUBLIC_KEYS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  ]

  for (const publicKey of [...new Set(publicKeys)]) {
    if (!/^G[A-Z2-7]{55}$/.test(publicKey))
      throw new Error(`Invalid public key: ${publicKey}`)
    const account = (await getAccount(publicKey)) as any
    const native = account.balances?.find(
      (balance: any) => balance.asset_type === 'native'
    )
    console.log(
      JSON.stringify({
        publicKey,
        nativeBalance: native?.balance || '0',
        numSponsoring: account.num_sponsoring ?? 0,
        numSponsored: account.num_sponsored ?? 0,
      })
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
