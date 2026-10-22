import mongoose from 'mongoose'

const { Schema } = mongoose
const { ObjectId } = Schema

const AiAssistUserSettingsSchema = new Schema(
  {
    user_id: { type: ObjectId, ref: 'User', required: true, unique: true },
    provider: {
      type: { type: String, default: null },
      baseUrl: { type: String, default: '' },
      apiKey: { type: String, default: null },
      model: { type: String, default: '' },
      modelName: { type: String, default: '' },
      contextWindow: { type: Number, default: null },
      maxOutputTokens: { type: Number, default: null },
    },
    fastProvider: {
      type: { type: String, default: null },
      baseUrl: { type: String, default: '' },
      apiKey: { type: String, default: null },
      model: { type: String, default: '' },
      modelName: { type: String, default: '' },
      contextWindow: { type: Number, default: null },
      maxOutputTokens: { type: Number, default: null },
    },
    webSearch: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: 'aiAssistUserSettings',
    minimize: false,
    bufferCommands: false,
  }
)

export const AiAssistUserSettingsModel = mongoose.model(
  'AiAssistUserSettings',
  AiAssistUserSettingsSchema
)
