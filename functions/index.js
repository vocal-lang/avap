import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const MASTER_ADMIN_EMAIL = "1982.vocal@gmail.com";

initializeApp();

function assertMasterAdmin(request) {
  const callerEmail = request.auth?.token?.email;
  if (!callerEmail || callerEmail !== MASTER_ADMIN_EMAIL) {
    throw new HttpsError(
      "permission-denied",
      "Only the master admin can manage accounts."
    );
  }
}

export const listAdminUsers = onCall(async (request) => {
  assertMasterAdmin(request);

  const auth = getAuth();

  try {
    const result = await auth.listUsers(1000);

    for (const user of result.users) {
      if (user.email === MASTER_ADMIN_EMAIL && !user.customClaims?.masterAdmin) {
        await auth.setCustomUserClaims(user.uid, {
          masterAdmin: true,
          canCreate: true,
          canEdit: true,
          canDelete: true,
        });
      }
    }

    // Never assign to user.customClaims — UserRecord can be non-extensible; that
    // throws in strict mode and the client sees functions/internal.
    return result.users.map((user) => {
      const isMaster = user.email === MASTER_ADMIN_EMAIL;
      const permissions = isMaster
        ? {
            masterAdmin: true,
            canCreate: true,
            canEdit: true,
            canDelete: true,
          }
        : {
            masterAdmin: user.customClaims?.masterAdmin || false,
            canCreate: user.customClaims?.canCreate || false,
            canEdit: user.customClaims?.canEdit || false,
            canDelete: user.customClaims?.canDelete || false,
          };

      return {
        uid: user.uid,
        email: user.email || "",
        creationTime: user.metadata.creationTime || "",
        permissions,
      };
    });
  } catch (err) {
    console.error("listAdminUsers:", err);
    if (err instanceof HttpsError) {
      throw err;
    }
    const adminCode = err?.errorInfo?.code || err?.code || "";
    const adminMsg = err?.errorInfo?.message || err?.message || "Unknown error";
    throw new HttpsError(
      "internal",
      adminMsg || "Could not list admin users.",
      { fn: "listAdminUsers", adminCode, adminMessage: adminMsg }
    );
  }
});

export const createAdminUser = onCall(async (request) => {
  assertMasterAdmin(request);

  const { email, password, canCreate, canEdit, canDelete } =
    request.data || {};

  if (!email || !password) {
    throw new HttpsError(
      "invalid-argument",
      "Email and password are required."
    );
  }

  if (password.length < 6) {
    throw new HttpsError(
      "invalid-argument",
      "Password must be at least 6 characters."
    );
  }

  const auth = getAuth();

  try {
    const userRecord = await auth.createUser({
      email,
      password,
    });

    await auth.setCustomUserClaims(userRecord.uid, {
      canCreate: !!canCreate,
      canEdit: !!canEdit,
      canDelete: !!canDelete,
    });

    return {
      uid: userRecord.uid,
      email: userRecord.email,
    };
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "An account with this email already exists.");
    }
    if (error.code === "auth/invalid-email") {
      throw new HttpsError("invalid-argument", "The email address is invalid.");
    }
    throw new HttpsError("internal", "An unexpected error occurred. Please try again.");
  }
});

export const deleteAdminUser = onCall(async (request) => {
  assertMasterAdmin(request);

  const { uid } = request.data || {};

  if (!uid) {
    throw new HttpsError("invalid-argument", "User UID is required.");
  }

  const auth = getAuth();

  const targetUser = await auth.getUser(uid);
  if (targetUser.email === MASTER_ADMIN_EMAIL) {
    throw new HttpsError(
      "permission-denied",
      "The master admin account cannot be deleted."
    );
  }

  await auth.deleteUser(uid);
  return { deleted: true, uid };
});

export const updateAdminPermissions = onCall(async (request) => {
  assertMasterAdmin(request);

  const { uid, canCreate, canEdit, canDelete } = request.data || {};

  if (!uid) {
    throw new HttpsError("invalid-argument", "User UID is required.");
  }

  const auth = getAuth();

  const targetUser = await auth.getUser(uid);
  if (targetUser.email === MASTER_ADMIN_EMAIL) {
    throw new HttpsError(
      "permission-denied",
      "The master admin's permissions cannot be modified."
    );
  }

  await auth.setCustomUserClaims(uid, {
    canCreate: !!canCreate,
    canEdit: !!canEdit,
    canDelete: !!canDelete,
  });

  return { updated: true, uid };
});

