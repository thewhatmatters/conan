// US-044: a tiny, dependency-free JSON Schema validator for the structured
// output of driven sessions. We don't pull in ajv — driven tasks describe their
// result with a small, hand-written schema, so we support the common subset:
//   type (incl. an array of allowed types), enum, const,
//   object: properties (recursive), required,
//   array:  items (recursive),
//   number/integer: minimum, maximum,
//   string: minLength, maxLength.
// Unknown keywords are ignored rather than failing, so a richer schema still
// validates against the parts we understand instead of being rejected outright.

/** A JSON Schema fragment — we only read the keywords listed above. */
export type JsonSchema = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  /** Human-readable `path: message` lines, empty when valid. */
  errors: string[];
}

/** A value is a "plausible" JSON Schema if it's a non-array object. */
export function isPlausibleSchema(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // "number" | "string" | "boolean" | "object" | ...
}

/** Does `value` satisfy the JSON Schema `type` keyword (string or string[])? */
function matchesType(value: unknown, type: string): boolean {
  const actual = jsonType(value);
  // JSON's "number" type accepts integers too.
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateNode(value: unknown, schema: JsonSchema, pathStr: string, errors: string[]): void {
  const at = pathStr || "(root)";

  // type ------------------------------------------------------------------
  const type = schema.type;
  if (typeof type === "string") {
    if (!matchesType(value, type)) {
      errors.push(`${at}: expected type ${type}, got ${jsonType(value)}`);
      return; // further keyword checks assume the type held
    }
  } else if (Array.isArray(type) && type.length) {
    if (!type.some((t) => typeof t === "string" && matchesType(value, t))) {
      errors.push(`${at}: expected one of [${type.join(", ")}], got ${jsonType(value)}`);
      return;
    }
  }

  // const / enum ----------------------------------------------------------
  if ("const" in schema && !deepEqual(value, schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  // object ----------------------------------------------------------------
  if (jsonType(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = isPlausibleSchema(schema.properties) ? schema.properties : null;
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push(`${at ? at + "." : ""}${key}: required property missing`);
        }
      }
    }
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj && isPlausibleSchema(sub)) {
          validateNode(obj[key], sub, pathStr ? `${pathStr}.${key}` : key, errors);
        }
      }
    }
  }

  // array -----------------------------------------------------------------
  if (Array.isArray(value) && isPlausibleSchema(schema.items)) {
    value.forEach((item, i) => {
      validateNode(item, schema.items as JsonSchema, `${pathStr}[${i}]`, errors);
    });
  }

  // numeric bounds --------------------------------------------------------
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${at}: ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${at}: ${value} > maximum ${schema.maximum}`);
    }
  }

  // string length ---------------------------------------------------------
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${at}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${at}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
  }
}

/**
 * Validate a structured result against a JSON Schema. Returns `{valid, errors}`;
 * a non-object schema is treated as "nothing to check" (valid) so an absent or
 * malformed schema never blocks surfacing the result.
 */
export function validateAgainstSchema(value: unknown, schema: unknown): ValidationResult {
  if (!isPlausibleSchema(schema)) return { valid: true, errors: [] };
  const errors: string[] = [];
  validateNode(value, schema, "", errors);
  return { valid: errors.length === 0, errors };
}
