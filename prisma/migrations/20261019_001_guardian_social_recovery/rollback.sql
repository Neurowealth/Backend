DROP TABLE "recovery_approvals";
DROP TABLE "recovery_requests";
DROP TABLE "recovery_guardians";
DROP TABLE "recovery_policies";
DROP TYPE "RecoveryRequestStatus";
-- Keep users.authPublicKey: recovery changes this credential independently of
-- walletAddress, and dropping it would lock recovered users out or redirect
-- their asset destination if the column were copied back.
