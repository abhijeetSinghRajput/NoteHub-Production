import mongoose from "mongoose";
import Collection from "../models/collection.model.js";
import Note from "../models/note.model.js";
import {
  getCache,
  setCache,
  cacheKeys,
  invalidateFeedsAndSearch,
  invalidateCollectionCache,
  invalidateNoteCache,
  fetchWithCache,
} from "../services/cache.service.js";
import User from "../models/user.model.js";
import { handleDbError } from "../utils/dbError.js";

export const createCollection = async (req, res) => {
  const { name, visibility, collaborators } = req.body;
  const { user } = req;

  if (!user) {
    return res.status(401).json({ message: "Unauthorized: user not found." });
  }
  if (!name) {
    return res.status(400).json({ message: "Collection name is required." });
  }
  try {
    const existingCollection = await Collection.findOne({
      name,
      userId: user._id,
    });

    if (existingCollection) {
      return res.status(400).json({
        message: `The repository ${name} already exists on this account`,
      });
    }

    const collection = await Collection.create({
      name,
      userId: user._id,
      visibility,
      collaborators: collaborators || [],
    });

    res.status(201).json({
      message: "Collection created successfully",
      collection: { ...collection._doc, notes: [] },
    });
  } catch (error) {
    console.error("Error in createCollection controller\n", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const deleteCollection = async (req, res) => {
  const { _id } = req.params;
  const { user } = req;

  if (!mongoose.Types.ObjectId.isValid(_id)) {
    return res.status(400).json({ message: "Invalid _id provided" });
  }

  if (!user) {
    return res.status(401).json({ message: "Unauthorized: user not found." });
  }

  try {
    const collection = await Collection.findById(_id);
    if (!collection) {
      return res.status(404).json({ message: "Collection not found." });
    }

    const isAdmin = user.role === "admin";
    if (collection.userId.toString() !== user._id.toString() && !isAdmin) {
      return res.status(403).json({
        message:
          "Forbidden: you do not have permission to delete this collection.",
      });
    }

    // deleting associated notes as well.
    await Note.deleteMany({ collectionId: _id });
    await Collection.findByIdAndDelete(_id);

    // Invalidate cache
    const owner = await User.findById(collection.userId);
    await invalidateCollectionCache(owner.userName, collection.slug);
    await invalidateFeedsAndSearch();

    res.status(200).json({ message: "Collection deleted successfully." });
  } catch (error) {
    console.error("Error in deleteCollection controller\n", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const renameCollection = async (req, res) => {
  const { _id, newName, newSlug } = req.body;
  const { user } = req;

  if (!_id || !newName) {
    return res.status(400).json({ message: "_id and newName are required." });
  }

  try {
    const collection = await Collection.findById(_id);
    if (!collection) {
      return res.status(404).json({ message: "Collection not found." });
    }

    const isAdmin = user.role === "admin";
    if (collection.userId.toString() !== user._id.toString() && !isAdmin) {
      return res.status(403).json({
        message: "You don't have permission to rename this collection.",
      });
    }

    const oldSlug = collection.slug;
    collection.name = newName;
    if (newSlug && newSlug !== oldSlug) {
      collection.slug = newSlug
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    }
    await collection.save();

    // Invalidate cache
    const owner = await User.findById(collection.userId);
    await invalidateCollectionCache(owner.userName, oldSlug);
    await invalidateCollectionCache(owner.userName, collection.slug);
    await invalidateFeedsAndSearch();

    res
      .status(200)
      .json({ message: "Collection renamed successfully.", collection });
  } catch (error) {
    console.error("Error in renameCollection controller\n", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const checkCollectionAvailability = async (req, res) => {
  const { slug, collectionId, userId } = req.query;
  const { user } = req;

  if (!user) return res.status(401).json({ message: "Unauthorized" });

  try {
    const targetUserId = user.role === "admin" && userId ? userId : user._id;

    const query = {
      userId: targetUserId,
      slug: slug.toLowerCase(),
    };

    if (collectionId && mongoose.Types.ObjectId.isValid(collectionId)) {
      query._id = { $ne: collectionId };
    }

    const exists = await Collection.exists(query);
    res.status(200).json({ available: !exists });
  } catch (error) {
    console.error("Error in checkCollectionAvailability:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getCollectionsAggregatePipeline = (
  userId,
  requester = null,
  slug = null,
  includeNoteCollaborators = false,
  minimal = false, 
) => {
  const requestingUserId = requester?._id;
  const requestingUserIdStr = requestingUserId
    ? String(requestingUserId)
    : null;
  const userIdStr = userId ? String(userId) : null;

  const isOwner =
    requestingUserIdStr && userIdStr && requestingUserIdStr === userIdStr;
  const isAdmin = requester?.role === "admin";
  const isCollaborator = requestingUserId && !isOwner && !isAdmin;
  const hasFullAccess = isOwner || isAdmin;

  const userIdObj = userIdStr ? new mongoose.Types.ObjectId(userIdStr) : null;
  const requestingUserIdObj = requestingUserIdStr
    ? new mongoose.Types.ObjectId(requestingUserIdStr)
    : null;

  // Base note projection — slim if minimal
  const noteProjection = minimal
    ? { _id: 1, name: 1, slug: 1, visibility: 1 }
    : {
        _id: 1,
        name: 1,
        slug: 1,
        visibility: 1,
        createdAt: 1,
        updatedAt: 1,
        seo: 1,
      };

  if (!minimal && includeNoteCollaborators) {
    noteProjection.collaborators = 1;
  }

  return [
    {
      $match: {
        $and: [
          ...(userIdObj ? [{ userId: userIdObj }] : []),
          ...(hasFullAccess
            ? []
            : [
                {
                  $or: [
                    { visibility: "public" },
                    ...(isCollaborator
                      ? [{ collaborators: requestingUserIdObj }]
                      : []),
                  ],
                },
              ]),
          ...(slug ? [{ slug: slug.toLowerCase() }] : []),
        ],
      },
    },
    ...(minimal
      ? []
      : [
          {
            $lookup: {
              from: "users",
              localField: "collaborators",
              foreignField: "_id",
              as: "collaborators",
              pipeline: [
                {
                  $project: {
                    _id: 1,
                    role: 1,
                    fullName: 1,
                    userName: 1,
                    avatar: 1,
                    email: 1,
                  },
                },
              ],
            },
          },
        ]),
    {
      $lookup: {
        from: "notes",
        let: { collectionId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$collectionId", "$$collectionId"] },
                  {
                    $or: [
                      { $eq: ["$visibility", "public"] },
                      ...(hasFullAccess ? [{ $eq: [true, true] }] : []),
                      ...(isCollaborator
                        ? [{ $in: [requestingUserIdObj, "$collaborators"] }]
                        : []),
                    ],
                  },
                ],
              },
            },
          },
          { $project: noteProjection },
          ...(!minimal && includeNoteCollaborators
            ? [
                {
                  $lookup: {
                    from: "users",
                    localField: "collaborators",
                    foreignField: "_id",
                    as: "collaborators",
                    pipeline: [
                      {
                        $project: {
                          _id: 1,
                          role: 1,
                          fullName: 1,
                          userName: 1,
                          avatar: 1,
                          email: 1,
                        },
                      },
                    ],
                  },
                },
              ]
            : []),
        ],
        as: "notes",
      },
    },
    ...(minimal
      ? [
          {
            $project: {
              _id: 1,
              name: 1,
              visibility: 1,
              slug: 1,
              notes: 1,
            },
          },
        ]
      : [
          {
            $addFields: {
              isRequesterCollaborator: isCollaborator,
              isOwner: isOwner,
              isAdmin: isAdmin,
            },
          },
          {
            $project: {
              _id: 1,
              name: 1,
              slug: 1,
              visibility: 1,
              userId: 1,
              createdAt: 1,
              updatedAt: 1,
              notes: 1,
              collaborators: {
                $cond: {
                  if: {
                    $or: [
                      "$isOwner",
                      "$isAdmin",
                      "$isRequesterCollaborator",
                    ],
                  },
                  then: "$collaborators",
                  else: "$$REMOVE",
                },
              },
            },
          },
        ]),
  ];
};

export const getAllCollections = async (req, res) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ message: "userId not provided" });
  }
  try {
    const requestingUserId = req.user?._id; // Check if user is authenticated
    const pipeline = getCollectionsAggregatePipeline(
      userId,
      req.user,
      null,
      false,
      true,
    );
    const collections = await Collection.aggregate(pipeline);

    res.status(200).json({ collections });
  } catch (error) {
    console.error("Error in getAllCollections controller\n", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const getCollection = async (req, res) => {
  const { userId, slug } = req.query;

  if (!userId || !slug) {
    return res.status(400).json({ message: "userId and slug are required" });
  }

  try {
    const requestingUserId = req.user?._id; // Check if user is authenticated
    const existingCollection = await Collection.exists({
      userId: new mongoose.Types.ObjectId(userId),
      slug: slug.toLowerCase(),
    });
    if (!existingCollection) {
      return res.status(404).json({ message: "Collection not found" });
    }
    const pipeline = getCollectionsAggregatePipeline(
      userId,
      req.user,
      slug.toLowerCase(),
      true, // Include note collaborators for getCollection
    );
    const collections = await Collection.aggregate(pipeline);

    if (!collections.length) {
      return res.status(403).json({ message: "Collection not accessible" });
    }

    res.status(200).json({ collection: collections[0] });
  } catch (error) {
    console.error("Error in getCollection controller\n", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

// controllers/collectionController.js
export const getCollectionBySlug = async (req, res) => {
  const { username, collectionSlug } = req.params;
  const requester = req.user || null;

  const normalizedUsername = username.trim().toLowerCase();
  const normalizedSlug = collectionSlug.trim().toLowerCase();
  const requesterId = requester?._id?.toString() || null;
  const isAdmin = requester?.role === "admin";
  const requesterIdObj =
    requesterId && mongoose.Types.ObjectId.isValid(requesterId)
      ? new mongoose.Types.ObjectId(requesterId)
      : null;

  const cacheKey = cacheKeys.collection.bySlug(
    normalizedUsername,
    normalizedSlug,
  );

  try {
    const { data } = await fetchWithCache(
      cacheKey,
      async () => {
        const result = await Collection.aggregate([
          // ─── STAGE 1: match collection owner ─────────────────────────────
          {
            $lookup: {
              from: "users",
              let: { uname: normalizedUsername },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$userName", "$$uname"] },
                    isDeleted: { $ne: true },
                    isBanned: { $ne: true },
                  },
                },
                { $project: { _id: 1, userName: 1, fullName: 1, avatar: 1, role: 1 } },
                { $limit: 1 },
              ],
              as: "ownerArr",
            },
          },

          // ─── STAGE 2: bail early if user not found ────────────────────────
          { $match: { "ownerArr.0": { $exists: true } } },

          // ─── STAGE 3: match the collection itself ─────────────────────────
          {
            $match: {
              $expr: {
                $eq: ["$userId", { $arrayElemAt: ["$ownerArr._id", 0] }],
              },
              slug: normalizedSlug,
              isDeleted: { $ne: true },
            },
          },

          // ─── STAGE 4: populate collection owner ───────────────────────────
          {
            $lookup: {
              from: "users",
              let: { ownerId: "$userId" },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$_id", "$$ownerId"] },
                    isDeleted: { $ne: true },
                    isBanned: { $ne: true },
                  },
                },
                { $project: { _id: 0, userName: 1, fullName: 1, avatar: 1, role: 1 } },
                { $limit: 1 },
              ],
              as: "userIdPopulated",
            },
          },

          // ─── STAGE 5: populate collaborators ─────────────────────────────
          {
            $lookup: {
              from: "users",
              let: { collabIds: { $ifNull: ["$collaborators", []] } },
              pipeline: [
                {
                  $match: {
                    $expr: { $in: ["$_id", "$$collabIds"] },
                    isDeleted: { $ne: true },
                    isBanned: { $ne: true },
                  },
                },
                { $project: { _id: 0, userName: 1, fullName: 1, avatar: 1 } },
              ],
              as: "collaboratorsPopulated",
            },
          },

          // ─── STAGE 6: fetch notes ─────────────────────────────────────────
          {
            $lookup: {
              from: "notes",
              let: { colId: "$_id" },
              pipeline: [
                {
                  $match: {
                    $expr: { $eq: ["$collectionId", "$$colId"] },
                    isDeleted: { $ne: true },
                  },
                },
                { $sort: { createdAt: -1 } },
                {
                  $project: {
                    _id: 1,
                    name: 1,
                    slug: 1,
                    visibility: 1,
                    createdAt: 1,
                    userId: 1,
                    "seo.title": 1,
                    "seo.description": 1,
                    "seo.image": 1,
                    "seo.score": 1, // stripped post-cache for non-owners
                  },
                },
              ],
              as: "notes",
            },
          },

          // ─── STAGE 7: populate note authors ──────────────────────────────
          {
            $lookup: {
              from: "users",
              let: {
                noteUserIds: {
                  $map: { input: "$notes", as: "n", in: "$$n.userId" },
                },
              },
              pipeline: [
                {
                  $match: {
                    $expr: { $in: ["$_id", "$$noteUserIds"] },
                    isDeleted: { $ne: true },
                    isBanned: { $ne: true },
                  },
                },
                { $project: { _id: 1, userName: 1, fullName: 1, avatar: 1 } },
              ],
              as: "noteAuthors",
            },
          },

          // ─── STAGE 8: shape final output ─────────────────────────────────
          {
            $project: {
              _id: 1,
              name: 1,
              slug: 1,
              visibility: 1,
              createdAt: 1,
              updatedAt: 1,
              userId: { $arrayElemAt: ["$userIdPopulated", 0] },
              collaborators: "$collaboratorsPopulated",
              // merge note authors back into notes
              notes: {
                $map: {
                  input: "$notes",
                  as: "note",
                  in: {
                    _id: "$$note._id",
                    name: "$$note.name",
                    slug: "$$note.slug",
                    visibility: "$$note.visibility",
                    createdAt: "$$note.createdAt",
                    seo: "$$note.seo",
                    userId: {
                      $let: {
                        vars: {
                          author: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$noteAuthors",
                                  as: "a",
                                  cond: { $eq: ["$$a._id", "$$note.userId"] },
                                },
                              },
                              0,
                            ],
                          },
                        },
                        in: {
                          userName: "$$author.userName",
                          fullName: "$$author.fullName",
                          avatar: "$$author.avatar",
                        },
                      },
                    },
                  },
                },
              },
              // carry owner for post-cache author field
              _owner: { $arrayElemAt: ["$ownerArr", 0] },
            },
          },
        ]);

        if (!result.length) {
          // distinguish 404 vs 403
          const exists = await Collection.exists({ slug: normalizedSlug });
          if (exists) {
            throw {
              status: 403,
              message: "Access denied",
              code: "ACCESS_DENIED",
            };
          }
          throw {
            status: 404,
            message: "Collection not found",
            code: "COLLECTION_NOT_FOUND",
          };
        }

        const raw = result[0];

        return {
          message: "Collection fetched successfully",
          // full data cached — visibility + score filtered per-request below
          _raw: raw,
        };
      },
      300,
    );

    // ─── POST-CACHE: per-requester filtering (no DB touch) ──────────────
    const raw = data._raw;
    const ownerId = raw.userId?.userName; // userName as stable identifier
    const isOwner = raw._owner?._id?.toString() === requesterId;
    const canSeeScore = isAdmin || isOwner;

    const isCollaborator = (raw.collaborators ?? []).some(
      (c) => c.userName === requester?.userName,
    );

    const visibleNotes = raw.notes.filter((note) => {
      if (note.visibility === "public") return true;
      if (isAdmin) return true;
      if (isOwner) return true;
      if (note.userId?.userName === requester?.userName) return true;
      if (isCollaborator) return true;
      return false;
    });

    const shapedNotes = visibleNotes.map((note) => ({
      ...note,
      seo: {
        title: note.seo?.title ?? null,
        description: note.seo?.description ?? null,
        image: note.seo?.image ?? null,
        ...(canSeeScore ? { score: note.seo?.score ?? null } : {}),
      },
    }));

    const collection = {
      _id: raw._id,
      name: raw.name,
      slug: raw.slug,
      visibility: raw.visibility,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      userId: raw.userId,
      collaborators: raw.collaborators ?? [],
      notes: shapedNotes,
      noteCount: shapedNotes.length,
    };

    return res.status(200).json({
      message: data.message,
      collection,
    });
  } catch (error) {
    if (error.status) {
      return res
        .status(error.status)
        .json({ message: error.message, code: error.code });
    }
    console.error("Error in getCollectionBySlug:", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const updateVisibility = async (req, res) => {
  const { visibility, collectionId } = req.body;
  const { user } = req;

  if (!user) return res.status(401).json({ message: "You are unauthorized" });
  if (!visibility || !collectionId) {
    return res.status(400).json({
      message: "all fields required [`visibility`, `collectionId`]",
    });
  }

  try {
    const collection = await Collection.findById(collectionId);
    if (!collection) {
      return res.status(404).json({ message: "Collection not found" });
    }

    const isAdmin = user.role === "admin";
    if (collection.userId.toString() !== user._id.toString() && !isAdmin) {
      return res.status(403).json({
        message:
          "You don't have permission to update this collection's visibility.",
      });
    }

    collection.visibility = visibility;
    await collection.save();

    // Invalidate cache
    const owner = await User.findById(collection.userId);
    await invalidateCollectionCache(owner.userName, collection.slug);
    await invalidateFeedsAndSearch();

    return res.status(200).json({
      message: `visiblity updated to ${collection.visibility}`,
      collection,
    });
  } catch (error) {
    console.error("Error in updateVisibility controller:", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};

export const updateCollaborators = async (req, res) => {
  let { collaborators, collectionId } = req.body;
  const { user } = req;

  if (!user) return res.status(401).json({ message: "You are unauthorized" });
  if (!Array.isArray(collaborators) || !collectionId) {
    return res.status(400).json({
      message: "all fields required [`collaborators: Array`, `collectionId`]",
    });
  }
  collaborators = [...new Set(collaborators)];

  try {
    const collection = await Collection.findById(collectionId);
    if (!collection) {
      return res.status(404).json({ message: "Collection not found" });
    }

    const isAdmin = user.role === "admin";
    if (collection.userId.toString() !== user._id.toString() && !isAdmin) {
      return res.status(403).json({
        message:
          "You don't have permission to update collaborators for this collection.",
      });
    }

    collection.collaborators = collaborators;
    await collection.save();

    // Invalidate cache
    const owner = await User.findById(collection.userId);
    await invalidateCollectionCache(owner.userName, collection.slug);
    await invalidateFeedsAndSearch();

    return res.status(200).json({
      message: "Collaborators updated successfully",
      collection: await collection.populate(
        "collaborators",
        "role fullName userName email avatar _id",
      ),
    });
  } catch (error) {
    console.error("Error in updateCollaborators controller:", error);
    const { status, message } = handleDbError(error);
    return res.status(status).json({ success: false, message });
  }
};
