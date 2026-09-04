import mongoose from 'mongoose';
import { NOTIFICATION_TYPE_VALUES } from '../config/constants.js';

/**
 * In-app notification. Delivered live over Socket.io and persisted so an agent
 * who was offline still sees what happened when they sign back in.
 */
const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true },

    // Both languages are stored so the bell renders correctly regardless of
    // which locale the recipient was using when the event fired.
    title: {
      ar: { type: String, required: true },
      en: { type: String, required: true },
    },
    body: {
      ar: { type: String },
      en: { type: String },
    },

    lead: { type: mongoose.Schema.Types.ObjectId, ref: 'Lead' },
    // Client-side route to open on click, e.g. "/leads/65f0...".
    link: { type: String },

    readAt: { type: Date },
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });
// Read notifications older than 60 days clean themselves up.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 60 });

export default mongoose.model('Notification', notificationSchema);
