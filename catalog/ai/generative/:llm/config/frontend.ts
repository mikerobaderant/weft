import type { NodeTemplate, ValidationContext, ValidationError } from '$lib/types';
import { Settings2 } from '@lucide/svelte';
import { hasConfigValue, isApiKeyReady } from '$lib/validation';

export const LlmConfigNode: NodeTemplate = {
	type: 'LlmConfig',
	label: 'LLM Config',
	description: 'LLM provider and parameters configuration. If you are using multiple llm nodes, consider using the same llm config node for all of them to simplify maintenance. Only use multiple config nodes if you really need different configurations for different LLM node.',
	isBase: true,
	icon: Settings2,
	color: '#6b6b99',
	category: 'AI',
	tags: ['config', 'ai', 'settings', 'model'],
	fields: [
		{ key: 'provider', label: 'Provider', type: 'select', options: ['openrouter', 'bedrock'], description: 'OpenRouter uses the API Key field below. Bedrock reads AWS credentials from the server environment (AWS_REGION + default AWS credential chain).' },
		{ key: 'apiKey', label: 'API Key', type: 'api_key', provider: 'openrouter', description: 'Used only when Provider = openrouter.' },
		{ key: 'model', label: 'Model', type: 'text', placeholder: 'anthropic/claude-3.5-sonnet', description: 'OpenRouter slug (e.g. anthropic/claude-sonnet-4.6) or Bedrock model ID / inference profile (e.g. us.anthropic.claude-sonnet-4-20250514-v1:0).' },
		{ key: 'systemPrompt', label: 'System Prompt', type: 'textarea', placeholder: 'You are a helpful assistant.' },
		{ key: 'maxTokens', label: 'Max Tokens', type: 'number', placeholder: '4096' },
		{ key: 'temperature', label: 'Temperature', type: 'number', placeholder: '0.7' },
		{ key: 'topP', label: 'Top P', type: 'number', placeholder: '1.0' },
		{ key: 'frequencyPenalty', label: 'Frequency Penalty', type: 'number', placeholder: '0.0', description: '-2.0 to 2.0' },
		{ key: 'presencePenalty', label: 'Presence Penalty', type: 'number', placeholder: '0.0', description: '-2.0 to 2.0' },
		{ key: 'reasoning', label: 'Enable Reasoning', type: 'checkbox', description: 'Enable extended thinking for supported models' },
		{ key: 'reasoningEffort', label: 'Reasoning Effort', type: 'select', options: ['low', 'medium', 'high'], description: 'Only used when reasoning is enabled' },
		{ key: 'seed', label: 'Seed', type: 'number', placeholder: 'Leave empty for random', description: 'For reproducible outputs' },
	],
	defaultInputs: [
		{ name: 'systemPrompt', portType: 'String', required: false, description: 'Optional system prompt. Can be wired from upstream or set as a config field.' },
	],
	defaultOutputs: [
		{ name: 'config', portType: 'JsonDict', required: false, description: 'LLM configuration object' },
	],
	features: {
	},
	validate: (context: ValidationContext): ValidationError[] => {
		const errors: ValidationError[] = [];

		const provider = context.config?.provider ?? 'openrouter';
		if (provider === 'openrouter' && !isApiKeyReady('apiKey', context.config)) {
			errors.push({ field: 'apiKey', message: 'Own key selected but not entered', level: 'runtime' });
		}
		if (!hasConfigValue('model', context.config)) {
			errors.push({ field: 'model', message: 'Model is required', level: 'structural' });
		}

		return errors;
	},
};
