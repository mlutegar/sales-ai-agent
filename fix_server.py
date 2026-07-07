with open('server.js', 'rb') as f:
    content = f.read()

new_content = bytearray()
i = 0
in_single = False
in_double = False
in_template = False
escaped = False
count = 0

while i < len(content):
    b = content[i:i+1]

    if escaped:
        new_content.extend(b)
        escaped = False
        i += 1
        continue

    bslash = b'\\'
    if b == bslash:
        escaped = True
        new_content.extend(b)
        i += 1
        continue

    sq = b"'"
    dq = b'"'
    bt = b'`'
    lf = b'\n'
    cr = b'\r'

    if not in_double and not in_template and b == sq:
        in_single = not in_single
        new_content.extend(b)
        i += 1
        continue

    if not in_single and not in_template and b == dq:
        in_double = not in_double
        new_content.extend(b)
        i += 1
        continue

    if not in_single and not in_double and b == bt:
        in_template = not in_template
        new_content.extend(b)
        i += 1
        continue

    if in_single:
        if b == cr:
            # Check for CRLF
            if i + 1 < len(content) and content[i+1:i+2] == lf:
                new_content.extend(b'\\n')
                count += 1
                i += 2
            else:
                new_content.extend(b'\\r')
                count += 1
                i += 1
            continue
        if b == lf:
            new_content.extend(b'\\n')
            count += 1
            i += 1
            continue

    new_content.extend(b)
    i += 1

print(f'Fixed {count} literal newlines inside single-quoted strings')

with open('server.js', 'wb') as f:
    f.write(bytes(new_content))

print('Done')
