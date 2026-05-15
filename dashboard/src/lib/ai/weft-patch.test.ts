import { describe, it, expect } from 'vitest';
import { applyWeftPatch } from '$lib/ai/weft-patch';

describe('weft-patch line boundary preservation', () => {
	it('partial replace inside node block preserves newline', () => {
		const source = [
			'filter = ExecPython {',
			'  label: "Filter"',
			'  in(*category: String, *all_items: List[String])',
			'  out(matching_items: List[String])',
			'  code: ' + '``' + '`',
			'mapping = {"fruit": ["apple", "banana"]}',
			'return {"matching_items": mapping.get(category, [])}',
			'  ' + '``' + '`',
			'}',
		].join('\n');

		const patch = `<<<<<<< SEARCH
  in(*category: String, *all_items: List[String])
  out(matching_items: List[String])
=======
  in(*category: String, *all_items: List[String])
  out(matching_items: String)
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		// The code: line must NOT be merged with the out() line
		expect(result.patched).toContain('out(matching_items: String)\n  code:');
		expect(result.patched).not.toContain('out(matching_items: String)  code:');
		expect(result.patched).not.toContain('out(matching_items: String)code:');
	});

	it('partial replace of single line preserves next line', () => {
		const source = [
			'node = ExecPython {',
			'  in(*data: String)',
			'  out(result: String)',
			'  code: ' + '``' + '`return {"result": data}' + '``' + '`',
			'}',
		].join('\n');

		const patch = `<<<<<<< SEARCH
  out(result: String)
=======
  out(result: Number)
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		expect(result.patched).toContain('out(result: Number)\n  code:');
	});

	it('replace at end of file without trailing newline', () => {
		const source = `node = Debug { label: "Test" }`;

		const patch = `<<<<<<< SEARCH
node = Debug { label: "Test" }
=======
node = Debug { label: "Fixed" }
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		expect(result.patched).toBe('node = Debug { label: "Fixed" }');
	});

	it('replace preserves blank line after block', () => {
		const source = `node1 = Text { value: "hello" }

node2 = Debug {}`;

		const patch = `<<<<<<< SEARCH
node1 = Text { value: "hello" }
=======
node1 = Text { value: "world" }
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		// The blank line between nodes must be preserved
		expect(result.patched).toContain('node1 = Text { value: "world" }\n\nnode2');
	});

	it('in() line change inside group preserves structure', () => {
		const source = `my_group = Group("MyGroup") {
  in(*data: String)
  out(result: String)

  worker = Template { template: "hi" }
  worker.value = in.data
  out.result = worker.output
}`;

		const patch = `<<<<<<< SEARCH
  in(*data: String)
=======
  in(*data: Number)
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		expect(result.patched).toContain('in(*data: Number)\n  out(result: String)');
	});

	it('multi-line in() replace preserves code block', () => {
		const source = [
			'node = ExecPython {',
			'  in(',
			'    *category: String',
			'    *items: List[String]',
			'    separator: String',
			'  )',
			'  out(report: String)',
			'  code: ' + '``' + '`',
			'return {"report": "test"}',
			'  ' + '``' + '`',
			'}',
		].join('\n');

		const patch = `<<<<<<< SEARCH
  in(
    *category: String
    *items: List[String]
    separator: String
  )
=======
  in(
    *category: String
    *items: List[String]
    separator: Number
  )
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.errors).toHaveLength(0);
		// out(report: String) must be on its own line
		expect(result.patched).toContain(')\n  out(report: String)');
	});
});

describe('weft-patch empty-SEARCH guard', () => {
	it('empty SEARCH on empty source becomes the whole project', () => {
		const patch = `<<<<<<< SEARCH
=======
node = Debug { label: "Hello" }
>>>>>>> REPLACE`;

		const result = applyWeftPatch('', patch);
		expect(result.errors).toHaveLength(0);
		expect(result.patched).toBe('node = Debug { label: "Hello" }');
	});

	it('empty SEARCH on non-empty source returns an error and leaves source unchanged', () => {
		const source = 'existing = Text { value: "keep me" }';
		const patch = `<<<<<<< SEARCH
=======
prepended = Debug {}
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.patched).toBe(source);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/empty SEARCH block/i);
	});

	it('mix of valid block and empty-SEARCH block: valid applies, empty errors', () => {
		const source = 'a = Text { value: "old" }';
		const patch = `<<<<<<< SEARCH
a = Text { value: "old" }
=======
a = Text { value: "new" }
>>>>>>> REPLACE
<<<<<<< SEARCH
=======
b = Debug {}
>>>>>>> REPLACE`;

		const result = applyWeftPatch(source, patch);
		expect(result.patched).toBe('a = Text { value: "new" }');
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toMatch(/empty SEARCH block/i);
	});
});
