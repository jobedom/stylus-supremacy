const Stylus = require('stylus')
const ordering = require('stylint/src/data/ordering.json')
const _ = require('lodash')

const createFormattingOptions = require('./createFormattingOptions')
const createStringBuffer = require('./createStringBuffer')

function format(content, options = {}) {
	// Stop processing if the input content is empty
	if (content.trim().length === 0) {
		return ''
	}

	// Consolidate the formatting options
	options = _.assign({ wrapMode: !!options.wrapMode }, createFormattingOptions(options))

	// Prepare the artifacts
	const comma = options.insertSpaceAfterComma ? ', ' : ','
	const openParen = options.insertSpaceInsideParenthesis ? '( ' : '('
	const closeParen = options.insertSpaceInsideParenthesis ? ' )' : ')'

	// Store the input content line-by-line
	const originalLines = content.split(/\r?\n/)

	let modifiedContent = content
	let originalTabStopChar = null // For example, "\t", "\s\s" and so on
	let originalBaseIndent = null // This could be zero or many occurrences of `originalTabStopChar`
	if (options.wrapMode) {
		// Wrap the input content in `wrap{...}` so that it has a root node
		// This is designed for https://github.com/ThisIsManta/vscode-stylus-supremacy
		if (originalLines.length === 1) {
			modifiedContent = 'wrap\n\t' + content.trim()
			originalBaseIndent = _.get(content.match(/^(\s|\t)*/g), '0', null)

		} else {
			// Determine an original tab stop character
			const twoShortestIndent = _.chain(originalLines)
				.filter(line => line.trim().length > 0)
				.map(line => _.get(line.match(/^(\s|\t)*/g), '0', ''))
				.uniq()
				.sortBy(text => text.length)
				.take(2)
				.value()
			if (twoShortestIndent.length === 2) {
				originalTabStopChar = twoShortestIndent[1].substring(twoShortestIndent[0].length)
			}
			originalBaseIndent = twoShortestIndent[0]

			// Normalize the original indentation
			modifiedContent = 'wrap\n' + originalLines.map(line => {
				if (line.trim().length > 0) {
					return (originalTabStopChar || '\t') + line.substring(twoShortestIndent[0].length)
				} else {
					return ''
				}
			}).join('\n')
		}
	}

	// Used to determine some information that `rootNode` does not offer
	// For example, a single-line comment
	const modifiedLines = modifiedContent.split(/\r?\n/)

	// Store the Stylus parsed tree
	const rootNode = new Stylus.Parser(modifiedContent).parse()

	function travel(parentNode, inputNode, indentLevel, insideExpression = false, data = {}) {
		// Check argument type
		if (!(_.isObject(parentNode) || parentNode === null && inputNode instanceof Stylus.nodes.Root)) {
			throw new Error(`Found a parent node of ${JSON.stringify(parentNode)}`)
		} else if (!(_.isObject(inputNode))) {
			throw new Error(`Found an input node of ${JSON.stringify(inputNode)}` + (parentNode ? `, which had a parent node of ${JSON.stringify(parentNode)}` : ''))
		} else if (!(_.isInteger(indentLevel) && indentLevel >= 0)) {
			throw new Error(`Found an indent level of ${JSON.stringify(indentLevel)}`)
		} else if (!(_.isBoolean(insideExpression))) {
			throw new Error(`Found an expression flag of ${JSON.stringify(insideExpression)}`)
		} else if (!(_.isPlainObject(data))) {
			throw new Error(`Found an additional data object of ${JSON.stringify(data)}`)
		}

		// Inject a parent node to the current working node
		inputNode.parent = parentNode

		// Prepare the indentation from the current indent level
		const indent = _.repeat(options.tabStopChar, indentLevel)

		// Store an output string for the current node
		const outputBuffer = createStringBuffer()

		// Insert sticky comment(s) before the current node
		if (inputNode.commentsOnTop) {
			outputBuffer.append(inputNode.commentsOnTop.map(node => travel(inputNode.parent, node, indentLevel)).join(''))
		}

		if (inputNode instanceof Stylus.nodes.Import) {
			outputBuffer.append(indent)
			outputBuffer.append('@')
			outputBuffer.append(options.alwaysUseImport || inputNode.once === false ? 'import' : 'require')
			outputBuffer.append(' ')
			outputBuffer.append(travel(inputNode, inputNode.path, indentLevel, true))

			if (options.insertSemicolons) {
				outputBuffer.append(';')
			}
			outputBuffer.append(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Group) {
			// Insert single-line comment(s)
			const topCommentNodes = tryGetSingleLineCommentNodesOnTheTopOf(_.first(inputNode.nodes))
			if (topCommentNodes.length > 0) {
				outputBuffer.append(topCommentNodes.map(node => travel(inputNode.parent, node, indentLevel)).join(''))
			}

			// Insert CSS selector(s)
			const separator = ',' + (options.insertNewLineBetweenSelectors ? (options.newLineChar + indent) : ' ')
			outputBuffer.append(indent + inputNode.nodes.map(node => travel(inputNode, node, indentLevel, true)).join(separator).trim())

			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, false, { potentialCommentNodeInsideTheBlock: _.last(inputNode.nodes) }))

		} else if (inputNode instanceof Stylus.nodes.Root || inputNode instanceof Stylus.nodes.Block) {
			const childIndentLevel = inputNode instanceof Stylus.nodes.Root ? 0 : (indentLevel + 1)

			if (inputNode instanceof Stylus.nodes.Block && (parentNode instanceof Stylus.nodes.Atblock ? options.alwaysUseAtBlock : options.insertBraces)) {
				outputBuffer.append(' {')
			}

			// Insert a comment on the right of the last selector
			const sideCommentNode = tryGetMultiLineCommentNodeOnTheRightOf(data.potentialCommentNodeInsideTheBlock) || tryGetSingleLineCommentNodeOnTheRightOf(data.potentialCommentNodeInsideTheBlock)
			if (sideCommentNode) {
				if (options.insertSpaceBeforeComment) {
					outputBuffer.append(' ')
				}
				outputBuffer.append(travel(inputNode.parent, sideCommentNode, indentLevel, true))
			}

			outputBuffer.append(options.newLineChar)

			// Filter multi-line comment(s)
			const commentNodes = inputNode.nodes.filter(node => node instanceof Stylus.nodes.Comment)
			const unsortedNonCommentNodes = _.difference(inputNode.nodes, commentNodes)

			const groupOfUnsortedNonCommentNodes = []
			unsortedNonCommentNodes.forEach((node, rank, list) => {
				if (rank === 0 || getType(node) !== getType(list[rank - 1]) || getType(node) === 'Block') {
					groupOfUnsortedNonCommentNodes.push([node])
				} else {
					_.last(groupOfUnsortedNonCommentNodes).push(node)
				}
			})

			const groupOfSortedNonCommentNodes = groupOfUnsortedNonCommentNodes.map(nodes => {
				if (nodes[0] instanceof Stylus.nodes.Property) {
					// Sort CSS properties
					if (options.sortProperties === 'alphabetical') {
						return _.sortBy(nodes, node => {
							const propertyName = node.segments.map(segment => segment.name).join('')
							if (propertyName.startsWith('-')) {
								return '~' + propertyName.substring(1)
							} else {
								return propertyName
							}
						})

					} else if (options.sortProperties === 'grouped') {
						// See also https://github.com/SimenB/stylint/blob/master/src/data/ordering.json
						return _.sortBy(nodes, node => {
							const propertyName = node.segments.map(segment => segment.name).join('')
							const propertyRank = ordering.grouped.indexOf(propertyName)
							if (propertyRank >= 0) {
								return propertyRank
							} else {
								return Infinity
							}
						})

					} else if (_.isArray(options.sortProperties) && _.some(options.sortProperties)) {
						return _.sortBy(nodes, node => {
							const propertyName = node.segments.map(segment => segment.name).join('')
							const propertyRank = options.sortProperties.indexOf(propertyName)
							if (propertyRank >= 0) {
								return propertyRank
							} else {
								return Infinity
							}
						})
					}
				}

				return nodes
			})

			// Note that do not mutate this
			const sortedNonCommentNodes = _.flatten(groupOfSortedNonCommentNodes)

			// Put single-line comment(s) to the relevant node
			sortedNonCommentNodes.forEach(node => {
				node.commentsOnTop = tryGetSingleLineCommentNodesOnTheTopOf(node)

				const rightCommentNode = tryGetSingleLineCommentNodeOnTheRightOf(node)
				if (rightCommentNode) {
					if (node.commentsOnRight === undefined) {
						node.commentsOnRight = []
					}
					node.commentsOnRight.push(rightCommentNode)
				}
			})

			// Put a sticky multi-line comment to the relevant node
			_.orderBy(commentNodes, ['lineno', 'column'], ['desc', 'asc']).forEach(comment => {
				const sideNode = sortedNonCommentNodes.find(node => node.lineno === comment.lineno && node.column < comment.column)
				if (sideNode) {
					if (sideNode.commentsOnRight === undefined) {
						sideNode.commentsOnRight = []
					}
					sideNode.commentsOnRight.push(comment)

				} else {
					const index = inputNode.nodes.indexOf(comment)
					if (index === inputNode.nodes.length - 1) {
						groupOfSortedNonCommentNodes.push([comment])

					} else {
						let belowNode = inputNode.nodes[index + 1]
						if (sortedNonCommentNodes.includes(belowNode)) {
							if (belowNode.commentsOnTop === undefined) {
								belowNode.commentsOnTop = []
							}
							belowNode.commentsOnTop.push(comment)

						} else if (belowNode instanceof Stylus.nodes.Comment) {
							belowNode = sortedNonCommentNodes.find(node => node.commentsOnTop && node.commentsOnTop.find(node => belowNode === node))
							belowNode.commentsOnTop.unshift(comment)
						}
					}
				}
			})

			const checkIf = (value) => {
				if (value === true) {
					return true

				} else if (options.wrapMode) {
					return _.some(originalBaseIndent) ? value === 'nested' : value === 'root'

				} else {
					return inputNode instanceof Stylus.nodes.Root ? value === 'root' : value === 'nested'
				}
			}

			// Insert CSS body and new-lines between them
			outputBuffer.append(_.chain(groupOfSortedNonCommentNodes)
				.map((nodes, rank, list) => {
					const nodeType = getType(nodes[0])

					let newLineOrEmpty = ''
					if (
						nodeType === 'Block' && checkIf(options.insertNewLineAroundBlocks) ||
						nodeType === 'Property' && checkIf(options.insertNewLineAroundProperties) ||
						nodeType === 'Import' && checkIf(options.insertNewLineAroundImports) ||
						nodeType === 'Other' && checkIf(options.insertNewLineAroundOthers)
					) {
						newLineOrEmpty = options.newLineChar
					}

					return _.compact([
						newLineOrEmpty,
						nodes.map(node => travel(inputNode, node, childIndentLevel)).join(''),
						newLineOrEmpty,
					])
				})
				.flatten()
				.reject((text, rank, list) => text === options.newLineChar && (
					rank === 0 ||
					rank > 1 && list[rank - 1] === options.newLineChar ||
					rank === list.length - 1
				))
				.join('')
				.value()
			)

			// Insert the bottom comment(s)
			const bottomCommentNodes = tryGetSingleLineCommentNodesOnTheBottomOf(_.last(unsortedNonCommentNodes))
			if (bottomCommentNodes) {
				outputBuffer.append(bottomCommentNodes.map(node => travel(inputNode.parent, node, childIndentLevel)).join(''))
			}

			if (inputNode instanceof Stylus.nodes.Block && (parentNode instanceof Stylus.nodes.Atblock ? options.alwaysUseAtBlock : options.insertBraces)) {
				outputBuffer.append(indent + '}')
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Selector) {
			outputBuffer.append(inputNode.segments.map(segment => travel(inputNode, segment, indentLevel, true)).join('').trim())

			if (inputNode.optional === true) {
				outputBuffer.append(' !optional')
			}

		} else if (inputNode instanceof Stylus.nodes.Property) {
			// Insert the property name
			const propertyName = inputNode.segments.map(segment => travel(inputNode, segment, indentLevel, true)).join('')
			outputBuffer.append(indent + propertyName)

			if (options.insertColons) {
				outputBuffer.append(':')
			}
			outputBuffer.append(' ')

			// Insert the property value(s)
			if (inputNode.expr instanceof Stylus.nodes.Expression) {
				// Extract the last portion of comments
				// For example,
				// margin: 8px 0; /* right-comment */
				const commentsOnTheRight = _.chain(inputNode.expr.nodes).clone().reverse().takeWhile(node => node instanceof Stylus.nodes.Comment).reverse().value()
				const nodesExcludingCommentsOnTheRight = inputNode.expr.nodes.slice(0, inputNode.expr.nodes.length - commentsOnTheRight.length)

				let propertyValues = nodesExcludingCommentsOnTheRight.map(node => travel(inputNode, node, indentLevel, true))

				// Reduce the redundant margin/padding values
				// For example,
				// margin: 0 0 0 0; => margin: 0;
				// margin: 5px 0 5px 0; => margin: 5px 0;
				if (options.reduceMarginAndPaddingValues && (propertyName === 'margin' || propertyName === 'padding') && nodesExcludingCommentsOnTheRight.some(node => node instanceof Stylus.nodes.Comment) === false) {
					if (propertyValues.length > 1 && propertyValues.every(text => text === propertyValues[0])) {
						propertyValues = [propertyValues[0]]
					} else if (propertyValues.length >= 3 && propertyValues[0] === propertyValues[2] && (propertyValues[1] === propertyValues[3] || propertyValues[3] === undefined)) {
						propertyValues = [propertyValues[0], propertyValues[1]]
					} else if (propertyValues.length === 4 && propertyValues[0] !== propertyValues[2] && propertyValues[1] === propertyValues[3]) {
						propertyValues = [propertyValues[0], propertyValues[1], propertyValues[2]]
					}
				} else if (propertyName === 'border' || propertyName === 'outline') {
					if (options.alwaysUseNoneOverZero && propertyValues.length === 1 && /^0(\.0*)?(\w+|\%)?/.test(propertyValues[0])) {
						propertyValues = ['none']
					}
				}

				// Insert the property value(s) without the last portion of comments
				if (nodesExcludingCommentsOnTheRight.every(node => node instanceof Stylus.nodes.Expression)) {
					outputBuffer.append(propertyValues.join(comma))
				} else {
					outputBuffer.append(propertyValues.join(' '))
				}

				// Put the last portion of comments aside
				if (commentsOnTheRight.length > 0) {
					if (inputNode.commentsOnRight === undefined) {
						inputNode.commentsOnRight = []
					}
					inputNode.commentsOnRight = inputNode.commentsOnRight.concat(commentsOnTheRight)
				}

			} else {
				const error = new Error('Found unknown object')
				error.data = inputNode
				throw error
			}

			if (options.insertSemicolons) {
				outputBuffer.append(';')
			}
			outputBuffer.append(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Literal) {
			if (_.isObject(inputNode.parent) && (inputNode.parent instanceof Stylus.nodes.Root || inputNode.parent instanceof Stylus.nodes.Block)) { // In case of @css
				// Note that it must be wrapped inside a pair of braces
				outputBuffer.append('@css {' + options.newLineChar)

				let innerLines = inputNode.val.split(/\r?\n/)

				// Adjust the original indentation
				if (innerLines.length === 1) {
					innerLines[0] = indent + innerLines[0].trim()

				} else if (innerLines.length >= 2) {
					const firstNonEmptyLineIndex = innerLines.findIndex(line => line.trim().length > 0)
					if (firstNonEmptyLineIndex >= 0) {
						innerLines = innerLines.slice(firstNonEmptyLineIndex)
						const firstLineIndent = innerLines[0].match(/^(\s|\t)+/)
						if (firstLineIndent) {
							const indentPattern = new RegExp(firstLineIndent[0], 'g')
							innerLines = innerLines.map(line => {
								const text = _.trimStart(line)
								const innerIndent = line.substring(0, line.length - text.length)
								return innerIndent.replace(indentPattern, options.tabStopChar) + text
							})
						}
					}
					if (_.last(innerLines).trim().length === 0) {
						innerLines = innerLines.slice(0, innerLines.length - 1)
					}
				}

				outputBuffer.append(innerLines.join(options.newLineChar))

				outputBuffer.append(options.newLineChar)
				outputBuffer.append('}' + options.newLineChar)

			} else {
				if (_.get(modifiedLines, (inputNode.lineno - 1) + '.' + (inputNode.column - 1)) === '\\') {
					outputBuffer.append('\\')
				}

				if (_.isString(inputNode.val)) {
					outputBuffer.append(inputNode.val)
				} else {
					outputBuffer.append(travel(inputNode, inputNode.val, indentLevel, true))
				}
			}

		} else if (inputNode instanceof Stylus.nodes.String) {
			outputBuffer.append(options.quoteChar)
			outputBuffer.append(inputNode.val)
			outputBuffer.append(options.quoteChar)

		} else if (inputNode instanceof Stylus.nodes.Ident) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			if (inputNode.property === true) { // In case of property lookup
				outputBuffer.append('@')
			}

			// Replace the identifier name with '@' for anonymous functions
			const currentIsAnonymousFunc = inputNode.name === 'anonymous' && inputNode.val instanceof Stylus.nodes.Function && inputNode.val.name === 'anonymous'
			if (currentIsAnonymousFunc) {
				outputBuffer.append('@')
			} else {
				outputBuffer.append(inputNode.name)
			}

			if (inputNode.val instanceof Stylus.nodes.Function) {
				outputBuffer.append(travel(inputNode, inputNode.val, indentLevel, false))

			} else if (inputNode.val instanceof Stylus.nodes.Expression) { // In case of assignments
				outputBuffer.append(' = ')
				const temp = travel(inputNode, inputNode.val, indentLevel, true)
				if (temp.startsWith(' ') || temp.startsWith(options.newLineChar)) {
					outputBuffer.remove(' ')
				}
				outputBuffer.append(temp)

			} else if (inputNode.val instanceof Stylus.nodes.BinOp && inputNode.val.left instanceof Stylus.nodes.Ident && inputNode.val.left.name === inputNode.name && inputNode.val.right) { // In case of self-assignments
				outputBuffer.append(' ' + inputNode.val.op + '= ')
				outputBuffer.append(travel(inputNode.val, inputNode.val.right, indentLevel, true))
			}

			const currentHasChildOfAnonymousFunc = inputNode.val instanceof Stylus.nodes.Expression && inputNode.val.nodes.length === 1 && inputNode.val.nodes[0] instanceof Stylus.nodes.Ident && inputNode.val.nodes[0].val instanceof Stylus.nodes.Function && inputNode.val.nodes[0].val.name === 'anonymous'

			const currentHasChildOfAtblock = inputNode.val instanceof Stylus.nodes.Expression && inputNode.val.nodes.length === 1 && inputNode.val.nodes[0] instanceof Stylus.nodes.Atblock

			if (insideExpression === false) {
				if (options.insertSemicolons && !(inputNode.val instanceof Stylus.nodes.Function || currentHasChildOfAnonymousFunc || currentHasChildOfAtblock)) {
					outputBuffer.append(';')
				}
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Function) {
			// Insert the parameter list
			outputBuffer.append(openParen)
			outputBuffer.append(travel(inputNode, inputNode.params, indentLevel, true))
			outputBuffer.append(closeParen)

			// Insert the function body
			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, false, { potentialCommentNodeInsideTheBlock: _.last(inputNode.params.nodes) }))

			// Trim a new-line generated by `Block` because it will cancel a new-line generated by `Ident`
			outputBuffer.remove(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Params) {
			outputBuffer.append(inputNode.nodes.map(node => travel(inputNode, node, indentLevel, true) + (node.rest ? '...' : '')).join(comma))

		} else if (inputNode instanceof Stylus.nodes.Call) {
			if (inputNode.block) { // In case of block mixins
				outputBuffer.append(indent + '+')
			}

			outputBuffer.append(inputNode.name)

			if (inputNode.name === 'url' && inputNode.args.nodes.length === 1 && inputNode.args.nodes[0] instanceof Stylus.nodes.Expression && inputNode.args.nodes[0].nodes.length > 1) { // In case of `url(non-string)`
				const modifiedArgument = new Stylus.nodes.Arguments()
				modifiedArgument.nodes = [new Stylus.nodes.String(inputNode.args.nodes[0].nodes.map(node => travel(inputNode.args, node, indentLevel, true)).join(''))]
				outputBuffer.append(travel(inputNode, modifiedArgument, indentLevel, true))

			} else {
				outputBuffer.append(travel(inputNode, inputNode.args, indentLevel, true))
			}

			if (inputNode.block) { // In case of block mixins
				outputBuffer.append(travel(inputNode, inputNode.block, indentLevel))
			}

		} else if (inputNode instanceof Stylus.nodes.Return) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			outputBuffer.append('return ')
			outputBuffer.append(travel(inputNode, inputNode.expr, indentLevel, true))

			if (insideExpression === false) {
				if (options.insertSemicolons) {
					outputBuffer.append(';')
				}
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Arguments) {
			outputBuffer.append(openParen)
			if (_.some(inputNode.map)) { // In case of named-arguments
				outputBuffer.append(_.toPairs(inputNode.map).map(pair =>
					pair[0] + ': ' + travel(inputNode, pair[1], indentLevel, true)
				).join(comma))

			} else {
				outputBuffer.append(inputNode.nodes.map(node => travel(inputNode, node, indentLevel, true)).join(comma))
			}
			outputBuffer.append(closeParen)

		} else if (inputNode instanceof Stylus.nodes.Expression) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			const parentIsSelector = inputNode.parent instanceof Stylus.nodes.Selector
			if (parentIsSelector) {
				outputBuffer.append('{')
			}

			const parentIsArithmeticOperator = inputNode.parent instanceof Stylus.nodes.UnaryOp || inputNode.parent instanceof Stylus.nodes.BinOp && inputNode.parent.left === inputNode
			if (parentIsArithmeticOperator) {
				outputBuffer.append(openParen)
			}

			const currentIsPartOfPropertyNames = !!findParentNode(inputNode, node => node instanceof Stylus.nodes.Property && node.segments.includes(inputNode))

			const currentIsPartOfKeyframes = !!findParentNode(inputNode, node => node instanceof Stylus.nodes.Keyframes && node.segments.includes(inputNode))

			outputBuffer.append(inputNode.nodes.map((node, rank) => {
				// Use either a white-space or a comma as a separator
				let separator
				if (rank === 0) {
					separator = ''
				} else {
					separator = ' '
					if (node.lineno > 0 && node.column > 0) {
						const currentLine = modifiedLines[node.lineno - 1]
						if (typeof currentLine === 'string' && _.last(_.trimEnd(currentLine.substring(0, node.column - 1))) === ',') {
							separator = comma
						}
					}
				}

				if (node instanceof Stylus.nodes.Ident && (currentIsPartOfPropertyNames || currentIsPartOfKeyframes || insideExpression === false) || node.mixin === true) {
					return separator + '{' + travel(inputNode, node, indentLevel, true) + '}'
				} else {
					return separator + travel(inputNode, node, indentLevel, true)
				}
			}).join(''))

			if (parentIsSelector) {
				outputBuffer.append('}')
			}

			if (parentIsArithmeticOperator) {
				outputBuffer.append(closeParen)
			}

			if (insideExpression === false) {
				if (options.insertSemicolons) {
					outputBuffer.append(';')
				}
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Unit) {
			if (!options.insertLeadingZeroBeforeFraction && typeof inputNode.val === 'number' && Math.abs(inputNode.val) < 1 && inputNode.val !== 0) {
				if (inputNode.val < 0) {
					outputBuffer.append('-')
				}
				outputBuffer.append(Math.abs(inputNode.val).toString().substring(1))
			} else {
				outputBuffer.append(inputNode.val)
			}

			if (!options.alwaysUseZeroWithoutUnit || inputNode.val !== 0) {
				outputBuffer.append(inputNode.type)
			}

		} else if (inputNode instanceof Stylus.nodes.UnaryOp) {
			outputBuffer.append(inputNode.op === '!' && options.alwaysUseNot ? 'not ' : inputNode.op)
			outputBuffer.append(travel(inputNode, inputNode.expr, indentLevel, true))

		} else if (inputNode instanceof Stylus.nodes.BinOp) {
			if (inputNode.op === '[]') { // In case of array accessing
				outputBuffer.append(travel(inputNode, inputNode.left, indentLevel, true))
				outputBuffer.append('[' + travel(inputNode, inputNode.right, indentLevel, true) + ']')

			} else if (inputNode.op === '...') { // In case of ranges
				outputBuffer.append(travel(inputNode, inputNode.left, indentLevel, true))
				outputBuffer.append('...')
				outputBuffer.append(travel(inputNode, inputNode.right, indentLevel, true))

			} else if (inputNode.op === '[]=') { // In case of object-property assignments
				outputBuffer.append(travel(inputNode, inputNode.left, indentLevel, true))
				outputBuffer.append('[')
				outputBuffer.append(travel(inputNode, inputNode.right, indentLevel, true))
				outputBuffer.append('] = ')
				outputBuffer.append(travel(inputNode, inputNode.val, indentLevel, true))

			} else {
				const escapeDivider = inputNode.op === '/'
				if (escapeDivider) {
					outputBuffer.append(openParen)
				}

				outputBuffer.append(travel(inputNode, inputNode.left, indentLevel, true))
				outputBuffer.append(' ' + inputNode.op)
				if (inputNode.right) {
					outputBuffer.append(' ' + travel(inputNode, inputNode.right, indentLevel, true))
				}

				if (escapeDivider) {
					outputBuffer.append(closeParen)
				}
			}

		} else if (inputNode instanceof Stylus.nodes.Ternary) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			if (insideExpression === false && inputNode.cond instanceof Stylus.nodes.BinOp && inputNode.cond.op === 'is defined') {
				inputNode.cond.parent = inputNode

				outputBuffer.append(inputNode.cond.left.name)
				outputBuffer.append(' ?= ')
				outputBuffer.append(travel(inputNode.cond, inputNode.cond.left.val, indentLevel, true))

			} else {
				outputBuffer.append(travel(inputNode, inputNode.cond, indentLevel, true))
				outputBuffer.append(' ? ')
				outputBuffer.append(travel(inputNode, inputNode.trueExpr, indentLevel, true))
				outputBuffer.append(' : ')
				outputBuffer.append(travel(inputNode, inputNode.falseExpr, indentLevel, true))
			}

			if (insideExpression === false) {
				if (options.insertSemicolons) {
					outputBuffer.append(';')
				}
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Boolean) {
			outputBuffer.append(inputNode.val.toString())

		} else if (inputNode instanceof Stylus.nodes.RGBA) {
			outputBuffer.append(inputNode.raw.trim())

		} else if (inputNode instanceof Stylus.nodes.Object) {
			const keyValuePairs = _.toPairs(inputNode.vals)
			if (keyValuePairs.length === 0) { // In case of an empty object
				outputBuffer.append('{}')

			} else if (keyValuePairs.map(pair => pair[1]).every(node => node.lineno === inputNode.lineno)) { // In case of one-line object-property spreading
				outputBuffer.append('{ ')
				outputBuffer.append(keyValuePairs.map(pair =>
					getProperVariableName(pair[0]) + ': ' +
					travel(inputNode, pair[1], indentLevel, true)
				).join(comma))
				outputBuffer.append(' }')

			} else { // In case of multiple-line object-property spreading
				const childIndent = indent + options.tabStopChar
				outputBuffer.append('{' + options.newLineChar)
				outputBuffer.append(keyValuePairs.map(pair =>
					childIndent +
					getProperVariableName(pair[0]) + ': ' +
					travel(inputNode, pair[1], indentLevel + 1, true)
				).join(',' + options.newLineChar))
				outputBuffer.append(options.newLineChar + indent + '}')
			}

		} else if (inputNode instanceof Stylus.nodes.If) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			const operation = inputNode.negate ? 'unless' : 'if'

			if (inputNode.postfix === true) {
				// Insert the `if` body
				outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, true))
				outputBuffer.append(' ' + operation + ' ')

				// Insert the `if` condition
				if (options.insertParenthesisAroundIfCondition) {
					outputBuffer.append(openParen)
				}
				outputBuffer.append(travel(inputNode, inputNode.cond, indentLevel, true))
				if (options.insertParenthesisAroundIfCondition) {
					outputBuffer.append(closeParen)
				}

				if (insideExpression === false) {
					if (options.insertSemicolons) {
						outputBuffer.append(';')
					}
					outputBuffer.append(options.newLineChar)
				}

			} else {
				if (insideExpression) {
					outputBuffer.append(' ')
				}

				// Insert the `if` condition
				outputBuffer.append(operation + ' ')
				if (options.insertParenthesisAroundIfCondition) {
					outputBuffer.append(openParen)
				}
				outputBuffer.append(travel(inputNode, inputNode.cond, indentLevel, true))
				if (options.insertParenthesisAroundIfCondition) {
					outputBuffer.append(closeParen)
				}

				// Insert the `if` body
				outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, false))

				// Insert `else` block(s)
				if (inputNode.elses.length > 0) {
					if (!options.insertNewLineBeforeElse) {
						outputBuffer.remove(options.newLineChar)
					}

					inputNode.elses.forEach((node, rank, list) => {
						if (!options.insertBraces) {
							outputBuffer.append(options.newLineChar)
							outputBuffer.append(indent)
						} else if (options.insertNewLineBeforeElse === true) {
							outputBuffer.append(indent)
						} else {
							outputBuffer.append(' ')
						}

						outputBuffer.append('else')
						outputBuffer.append(travel(inputNode, node, indentLevel, true))

						// Remove the extra new-line generated by `Block`
						if (!options.insertNewLineBeforeElse && rank < list.length - 1) {
							outputBuffer.remove(options.newLineChar)
						}
					})
				}
			}

		} else if (inputNode instanceof Stylus.nodes.Each) {
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}

			const currentHasOnlyOneChild = _.size(inputNode.block.nodes) === 1
			const currentIsOnTheSameLineAsBody = inputNode.lineno === inputNode.block.nodes[0].lineno && inputNode.block.nodes[0].column < inputNode.column
			if (currentHasOnlyOneChild && currentIsOnTheSameLineAsBody) { // In case of postfix
				outputBuffer.append(travel(inputNode, inputNode.block.nodes[0], indentLevel, true))
				outputBuffer.append(' for ')
				outputBuffer.append(_.compact([inputNode.val, inputNode.key]).join(comma))
				outputBuffer.append(' in ')
				outputBuffer.append(travel(inputNode, inputNode.expr, indentLevel, true))

				if (insideExpression === false) {
					if (options.insertSemicolons) {
						outputBuffer.append(';')
					}
					outputBuffer.append(options.newLineChar)
				}

			} else {
				outputBuffer.append('for ')
				outputBuffer.append(_.compact([inputNode.val, inputNode.key]).join(comma))
				outputBuffer.append(' in ')
				outputBuffer.append(travel(inputNode, inputNode.expr, indentLevel, true))
				outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, false))
			}

		} else if (inputNode instanceof Stylus.nodes.Media) {
			outputBuffer.append(indent + '@media ')
			outputBuffer.append(travel(inputNode, inputNode.val, indentLevel))
			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel))

		} else if (inputNode instanceof Stylus.nodes.Keyframes) {
			outputBuffer.append(indent + '@keyframes ')
			outputBuffer.append(inputNode.segments.map(segment => travel(inputNode, segment, indentLevel, true)).filter(text => text.trim().length > 0).join(comma))
			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel))

		} else if (inputNode instanceof Stylus.nodes.QueryList) {
			outputBuffer.append(inputNode.nodes.map(node => travel(inputNode, node, indentLevel, true)).join(comma))

		} else if (inputNode instanceof Stylus.nodes.Query) {
			if (inputNode.predicate) {
				outputBuffer.append(inputNode.predicate + ' ')
			}
			if (inputNode.type) {
				outputBuffer.append(travel(inputNode, inputNode.type, indentLevel, true))
			}
			if (inputNode.nodes.length > 0) {
				if (inputNode.type) {
					outputBuffer.append(' and ')
				}
				outputBuffer.append(inputNode.nodes.map(node => travel(inputNode, node, indentLevel, true)).join(' and '))
			}

		} else if (inputNode instanceof Stylus.nodes.Feature) {
			outputBuffer.append(openParen)
			outputBuffer.append(inputNode.segments.map(segment => travel(inputNode, segment, indentLevel, true)).join(''))
			outputBuffer.append(': ')
			outputBuffer.append(travel(inputNode, inputNode.expr, indentLevel, true))
			outputBuffer.append(closeParen)

		} else if (inputNode instanceof Stylus.nodes.Supports) {
			outputBuffer.append(indent + '@supports ')
			outputBuffer.append(travel(inputNode, inputNode.condition, indentLevel, true))
			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel, false))

		} else if (inputNode instanceof Stylus.nodes.Extend) {
			outputBuffer.append(indent)
			if (options.alwaysUseExtends) {
				outputBuffer.append('@extends')
			} else {
				outputBuffer.append('@extend')
			}
			outputBuffer.append(' ')
			outputBuffer.append(inputNode.selectors.map(node => travel(inputNode, node, indentLevel, true)).join(comma))
			if (options.insertSemicolons) {
				outputBuffer.append(';')
			}
			outputBuffer.append(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Atrule) {
			outputBuffer.append(indent + '@' + inputNode.type)
			if (_.some(inputNode.segments)) {
				outputBuffer.append(' ')
				outputBuffer.append(inputNode.segments.map(segment => travel(inputNode, segment, indentLevel, true)).join(''))
			}
			if (inputNode.block) {
				outputBuffer.append(travel(inputNode, inputNode.block, indentLevel))
			} else if (options.insertSemicolons) {
				outputBuffer.append(';')
			}

		} else if (inputNode instanceof Stylus.nodes.Atblock) {
			if (options.alwaysUseAtBlock) {
				outputBuffer.append('@block')
			}
			outputBuffer.append(travel(inputNode, inputNode.block, indentLevel))

			// Remove the extra new-line because of `Ident` and `Block`
			outputBuffer.remove(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Charset) {
			outputBuffer.append('@charset ')
			outputBuffer.append(travel(inputNode, inputNode.val, indentLevel, true))

		} else if (inputNode instanceof Stylus.nodes.Namespace) {
			outputBuffer.append('@namespace ')
			if (inputNode.prefix) {
				outputBuffer.append(inputNode.prefix + ' ')
			}
			// Note that `inputNode.val.val` is not a typo
			outputBuffer.append(travel(inputNode, inputNode.val.val, indentLevel, true))

			if (options.insertSemicolons) {
				outputBuffer.append(';')
			}
			outputBuffer.append(options.newLineChar)

		} else if (inputNode instanceof Stylus.nodes.Comment && inputNode.str.startsWith('//')) { // In case of single-line comments
			if (inputNode.insertNewLineAbove) {
				outputBuffer.append(options.newLineChar)
			}
			if (insideExpression === false) {
				outputBuffer.append(indent)
			}
			outputBuffer.append('//' + (options.insertSpaceAfterComment ? ' ' : ''))
			outputBuffer.append(inputNode.str.substring(2).trim())
			if (insideExpression === false) {
				outputBuffer.append(options.newLineChar)
			}

		} else if (inputNode instanceof Stylus.nodes.Comment && inputNode.str.startsWith('/*')) { // In case of multi-line comments
			const spaceAfterComment = (options.insertSpaceAfterComment ? ' ' : '')

			// Split into an array of lines
			let commentLines = inputNode.str.split(/\r?\n/).map(line => line.trim())

			if (commentLines.length === 1) { // In case of one line only
				// Add a white-space between /* and */
				commentLines[0] = '/*' + spaceAfterComment + commentLines[0].substring(2, commentLines[0].length - 2).trim() + spaceAfterComment + '*/'

			} else { // In case of multiple lines
				const documenting = _.first(commentLines).startsWith('/**')

				// Add a white-space after /*
				if (_.first(commentLines) !== '/*' && documenting === false) {
					commentLines[0] = '/*' + spaceAfterComment + _.first(commentLines).substring(2).trim()
				}

				// Add indentation to in-between lines
				let zeroBasedLineIndex = 0
				while (++zeroBasedLineIndex <= commentLines.length - 2) {
					if (documenting) {
						if (commentLines[zeroBasedLineIndex].startsWith('*')) {
							if (commentLines[zeroBasedLineIndex].substring(1).charAt(0) === ' ') {
								commentLines[zeroBasedLineIndex] = ' *' + commentLines[zeroBasedLineIndex].substring(1)
							} else {
								commentLines[zeroBasedLineIndex] = ' *' + spaceAfterComment + commentLines[zeroBasedLineIndex].substring(1)
							}
						} else {
							commentLines[zeroBasedLineIndex] = ' *' + spaceAfterComment + commentLines[zeroBasedLineIndex]
						}
					} else {
						commentLines[zeroBasedLineIndex] = '  ' + spaceAfterComment + commentLines[zeroBasedLineIndex]
					}
				}

				// Add a white-space before */
				if (_.last(commentLines) === '*/') {
					if (documenting) {
						commentLines[commentLines.length - 1] = ' ' + _.last(commentLines)
					}
				} else {
					commentLines[commentLines.length - 1] = '   ' + _.trimEnd(_.last(commentLines).substring(0, _.last(commentLines).length - 2)) + spaceAfterComment + '*/'
				}
			}

			if (insideExpression) {
				// For example,
				// margin: 8px /* standard */ 0;
				outputBuffer.append(commentLines.join(options.newLineChar))

			} else {
				outputBuffer.append(commentLines.map(line => indent + line).join(options.newLineChar)).append(options.newLineChar)
			}

		} else {
			const error = new Error('Found unknown object')
			error.data = inputNode
			throw error
		}

		// Insert sticky comment(s) on the right of the current node
		if (inputNode.commentsOnRight) {
			outputBuffer.remove(options.newLineChar)
			if (options.insertSpaceBeforeComment) {
				outputBuffer.append(' ')
			}
			outputBuffer.append(inputNode.commentsOnRight.map(node => travel(inputNode.parent, node, indentLevel, true)).join(''))
			outputBuffer.append(options.newLineChar)
		}

		return outputBuffer.toString()
	}

	// Store the line indexes of single-line comments that have been processed
	// This prevents picking up duplicate comments
	const usedStandaloneSingleLineComments = {}

	function tryGetSingleLineCommentNodesOnTheTopOf(inputNode) {
		let zeroBasedLineIndex
		if (inputNode instanceof Stylus.nodes.Group && _.some(inputNode.nodes)) {
			zeroBasedLineIndex = inputNode.nodes[0].lineno - 1
		} else {
			zeroBasedLineIndex = inputNode.lineno - 1
		}

		let commentNodes = []
		while (--zeroBasedLineIndex >= 0 && modifiedLines[zeroBasedLineIndex] !== undefined) {
			const text = modifiedLines[zeroBasedLineIndex].trim()
			if (text === '') {
				if (commentNodes.length > 0) {
					commentNodes[0].insertNewLineAbove = true
				}

			} else if (text.startsWith('//') === false) {
				break

			} else if (!usedStandaloneSingleLineComments[zeroBasedLineIndex]) {
				usedStandaloneSingleLineComments[zeroBasedLineIndex] = true
				commentNodes.unshift(new Stylus.nodes.Comment(text, false, false))
			}
		}

		if (commentNodes.length > 0) {
			commentNodes[0].insertNewLineAbove = false
		}

		return commentNodes
	}

	function tryGetSingleLineCommentNodesOnTheBottomOf(inputNode) {
		if (!inputNode) {
			return null
		}

		// Skip operation for `Group` type
		if (inputNode instanceof Stylus.nodes.Group) {
			return null
		}

		let zeroBasedLineIndex = inputNode.lineno - 1

		// Skip operation when `inputNode.lineno` is not valid
		if (modifiedLines[zeroBasedLineIndex] === undefined) {
			return null
		}

		const commentNodes = []
		const sourceNodeIndent = modifiedLines[zeroBasedLineIndex].substring(0, modifiedLines[zeroBasedLineIndex].length - _.trimStart(modifiedLines[zeroBasedLineIndex]).length)
		while (++zeroBasedLineIndex < modifiedLines.length && modifiedLines[zeroBasedLineIndex].trim().startsWith('//') && modifiedLines[zeroBasedLineIndex].startsWith(sourceNodeIndent)) {
			if (usedStandaloneSingleLineComments[zeroBasedLineIndex]) {
				break
			} else {
				usedStandaloneSingleLineComments[zeroBasedLineIndex] = true
				commentNodes.push(new Stylus.nodes.Comment(modifiedLines[zeroBasedLineIndex].trim(), false, false))
			}
		}

		return commentNodes
	}

	function tryGetSingleLineCommentNodeOnTheRightOf(inputNode) {
		if (!inputNode || modifiedLines[inputNode.lineno - 1] !== undefined && modifiedLines[inputNode.lineno - 1].substring(inputNode.column - 1).includes('//') === false) {
			return null
		}

		// Skip operation for `Group` type
		if (inputNode instanceof Stylus.nodes.Group) {
			return null
		}

		let currentLine = modifiedLines[inputNode.lineno - 1]
		if (currentLine === undefined) {
			return null
		}

		// Skip operation if the only "//" is in the string
		let zeroBasedLineIndex = inputNode.column
		const leftmostStringThatHasDoubleSlashes = _.chain(findChildNodes(inputNode, node => node instanceof Stylus.nodes.String))
			.filter(node => node.lineno === inputNode.lineno && node.val.includes('//'))
			.maxBy('column')
			.value()
		if (leftmostStringThatHasDoubleSlashes) {
			zeroBasedLineIndex = leftmostStringThatHasDoubleSlashes.column + leftmostStringThatHasDoubleSlashes.val.length + 1
		}
		if (currentLine.indexOf('//', zeroBasedLineIndex) === -1) {
			return null
		}

		return new Stylus.nodes.Comment(currentLine.substring(currentLine.indexOf('//', zeroBasedLineIndex)).trim(), false, false)
	}

	function tryGetMultiLineCommentNodeOnTheRightOf(inputNode) {
		if (!inputNode || modifiedLines[inputNode.lineno - 1].substring(inputNode.column - 1).includes('/*') === false) {
			return null
		}

		let zeroBasedLineIndex = inputNode.lineno - 1
		let currentLine = modifiedLines[zeroBasedLineIndex]
		currentLine = currentLine.substring(currentLine.indexOf('/*', inputNode.column))
		if (currentLine.includes('*/')) {
			currentLine = currentLine.substring(0, currentLine.indexOf('*/') + 2)
		} else {
			while (++zeroBasedLineIndex < modifiedLines.length) {
				if (currentLine.includes('*/')) {
					currentLine = currentLine.substring(0, currentLine.indexOf('*/') + 2)
					break
				} else {
					currentLine += options.newLineChar
					currentLine += modifiedLines[zeroBasedLineIndex]
				}
			}
		}
		return new Stylus.nodes.Comment(currentLine, false, false)
	}

	function findParentNode(inputNode, condition) {
		const workingNode = inputNode && inputNode.parent
		if (!workingNode) {
			return null

		} else if (condition(workingNode)) {
			return workingNode

		} else {
			return findParentNode(workingNode, condition)
		}
	}

	function findChildNodes(inputNode, condition, results = [] /* Internal */, visited = [] /* Internal */) {
		if (inputNode && visited.includes(inputNode) === false) {
			// Remember the visited nodes to prevent stack overflow
			visited.push(inputNode)

			if (condition(inputNode)) {
				results.push(inputNode)
			}

			Object.getOwnPropertyNames(inputNode).forEach(name => {
				const prop = inputNode[name]
				if (_.isArray(prop)) {
					_.forEach(prop, node => {
						findChildNodes(node, condition, results, visited)
					})
				} else if (_.isObject(prop)) {
					findChildNodes(prop, condition, results, visited)
				}
			})
		}
		return results
	}

	function getType(inputNode) {
		if (inputNode instanceof Stylus.nodes.Property) {
			return 'Property'

		} else if (inputNode instanceof Stylus.nodes.Import) {
			return 'Import'

		} else if (inputNode.block !== undefined || (inputNode instanceof Stylus.nodes.Ident && inputNode.val.block !== undefined)) {
			return 'Block'

		} else {
			return 'Other'
		}
	}

	function getProperVariableName(name) {
		if (/^\d/.test(name) || /\s/.test(name)) {
			return options.quoteChar + name + options.quoteChar

		} else {
			return name
		}
	}

	const outputText = travel(null, rootNode, 0)
	let outputLines = outputText.split(new RegExp(_.escapeRegExp(options.newLineChar)))

	// Trim a beginning new-line character
	if (_.first(outputLines).trim().length === 0) {
		outputLines.shift()
	}

	// Trim all trailing new-line characters
	while (outputLines.length > 0 && _.last(outputLines).trim().length === 0) {
		outputLines.pop()
	}

	if (options.wrapMode) {
		// Remove the wrap node block
		if (outputLines[0].startsWith('wrap')) {
			outputLines.shift()
		}
		if (options.insertBraces && _.last(outputLines).trim() === '}') {
			outputLines.pop()
		}

		// Remove the wrap node indentation
		outputLines = outputLines.map(line => line.startsWith(options.tabStopChar) ? line.substring(options.tabStopChar.length) : line)

		// Add the original base indentation
		if (originalBaseIndent && originalTabStopChar) {
			const outputBaseIndent = _.repeat(options.tabStopChar, originalBaseIndent.length / originalTabStopChar.length)
			outputLines = outputLines.map(line => line.trim().length > 0 ? (outputBaseIndent + line) : '')
		} else if (originalBaseIndent) {
			outputLines = outputLines.map(line => line.trim().length > 0 ? (originalBaseIndent + line) : '')
		}
	}

	// Add a beginning new-line character
	// Do not move this block
	if (originalLines[0].length === 0) {
		outputLines.unshift('')
	}

	// Add a trailing new-line character if the original content has it
	// Do not move this block
	if (originalLines.length > 1 && content.substring(content.lastIndexOf('\n') + 1).trim().length === 0) {
		outputLines.push('')
	}

	return outputLines.join(options.newLineChar)
}

module.exports = format